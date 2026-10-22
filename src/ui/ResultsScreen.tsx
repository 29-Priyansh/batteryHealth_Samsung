import { Capacitor } from '@capacitor/core';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { aggregate, compare, predict, type Comparison, type ConfigStats } from '../engine/compare';
import { DEFAULT_SELECTION, enumerateConfigs, displayCode, getParam, type TestType } from '../engine/params';
import { everydayStats, everydaySteps, isEveryday, type EverydayStats } from '../engine/everyday';
import { extractSteps, type SessionRows, type SessionSteps } from '../engine/steps';
import type { SessionData } from '../native/batteryLab';
import { formatHours, Segmented, toast } from './components';
import { exportJson, loadSessions, samplesCsv, saveExport, stamp, updatePriors } from './data';
import { loadSetting } from './settingsStore';

/** Ranges used for the headline prediction of each configuration. */
const PREDICT: Record<TestType, [number, number]> = { draining: [100, 20], charging: [20, 80] };

export function ResultsScreen() {
  const [type, setType] = useState<TestType>('draining');
  const [source, setSource] = useState<'tests' | 'everyday'>('tests');
  const [data, setData] = useState<SessionData[] | null>(null);
  const [selection, setSelection] = useState<Record<TestType, string[]> | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    (async () => {
      setSelection({
        charging: await loadSetting('selection.charging', DEFAULT_SELECTION.slice()),
        draining: await loadSetting('selection.draining', DEFAULT_SELECTION.slice()),
      });
      try {
        const all = await loadSessions();
        setData(all);
        void updatePriors(all); // keep the live estimate's history current
      } catch (e) { toast(String(e)); setData([]); }
    })();
  }, []);

  const steps: SessionSteps[] = useMemo(() => {
    if (!data || !selection) return [];
    return data
      .filter((d) => d.session.type === type && !isEveryday(d))
      .map((d) => extractSteps(d as unknown as SessionRows, selection[type]));
  }, [data, selection, type]);
  const stats = useMemo(() => aggregate(steps), [steps]);
  const everyday = useMemo(
    () => (data && selection ? everydayStats(everydaySteps(data as unknown as SessionRows[], selection[type], type)) : []),
    [data, selection, type],
  );
  useEffect(() => setPicked([]), [type, source]);

  if (!Capacitor.isNativePlatform()) return <p class="muted center">Results are computed on the phone.</p>;
  if (!data || !selection) return <p class="muted center">Calculating…</p>;

  const allConfigs = enumerateConfigs(selection[type], type);
  const usable = stats.filter((s) => s.sessions.length > 0);
  const tooShort = stats.reduce((n, s) => n + s.shortSessions, 0);
  const noData = steps.filter((s) => s.steps.length === 0).length;
  const pick = (c: string) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c].slice(-2)));
  const pair = picked.length === 2 ? [stats.find((s) => s.config === picked[0])!, stats.find((s) => s.config === picked[1])!] : null;

  const exportAll = async (kind: 'csv' | 'json') => {
    const name = `battery-lab-all-${stamp()}`;
    if (kind === 'csv') await saveExport(`${name}.csv`, 'text/csv', samplesCsv(data));
    else await saveExport(`${name}.json`, 'application/json', exportJson(data, selection));
  };

  return (
    <section>
      <Segmented options={['tests', 'everyday'] as const} value={source} onChange={setSource}
        label={(v) => (v === 'tests' ? 'From tests' : 'Everyday use')} />
      <Segmented options={['draining', 'charging'] as const} value={type} onChange={setType}
        label={(t) => (t === 'charging' ? 'Charging' : 'Draining')} />

      {source === 'everyday' ? <EverydayResults type={type} stats={everyday} selection={selection[type]} /> : <>

      <p class="muted small">
        {steps.length} {type} test{steps.length === 1 ? '' : 's'} · {usable.length} of {allConfigs.length} configurations measured.
        {' '}Rates come from completed 1% steps; each test counts once per configuration.
      </p>

      {usable.length === 0 ? (
        <div class="card"><p>No {type} results yet. A test needs at least 3 completed 1% steps in one configuration to count.</p></div>
      ) : (
        <>
          <p class="muted small">Tap two configurations to compare them.</p>
          <ul class="results">
            {usable.map((st) => (
              <ConfigCard st={st} type={type} code={displayCode(st.config, allConfigs)}
                picked={picked.includes(st.config)} onPick={() => pick(st.config)} />
            ))}
          </ul>
        </>
      )}

      {pair && <ComparisonCard type={type} a={pair[0]!} b={pair[1]!} allConfigs={allConfigs} />}

      {(tooShort > 0 || noData > 0) && (
        <p class="muted small">
          {tooShort > 0 && `${tooShort} test segment${tooShort === 1 ? ' was' : 's were'} too short to count (under 3 steps). `}
          {noData > 0 && `${noData} test${noData === 1 ? ' has' : 's have'} no usable steps for the current Setup selection (e.g. a setting wasn't confirmed).`}
        </p>
      )}

      </>}

      <div class="card">
        <h3>Export</h3>
        <p class="muted small">All tests: raw observations (CSV) or raw data with computed results (JSON, estimator v1).</p>
        <div class="actions">
          <button onClick={() => exportAll('csv')}>Export CSV</button>
          <button onClick={() => exportAll('json')}>Export JSON</button>
        </div>
      </div>
    </section>
  );
}

/**
 * Everyday results: per configuration (automatic settings only), screen-off and screen-on
 * rates separately. Comparisons use screen-off steps only; screen-on is "typical for your use".
 */
function EverydayResults({ type, stats, selection }: { type: TestType; stats: EverydayStats[]; selection: string[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const allConfigs = enumerateConfigs(selection.filter((k) => { try { return getParam(k).detection === 'auto'; } catch { return false; } }), type);
  const usable = stats.filter((s) => s.all.sessions.length > 0);
  const pick = (c: string) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c].slice(-2)));
  const pair = picked.length === 2 ? picked.map((c) => stats.find((s) => s.config === c)!) : null;
  const [from, to] = PREDICT[type];

  if (usable.length === 0) {
    return (
      <div class="card">
        <p>No everyday data yet. Turn on <b>Always-on</b> on the Test tab; results build up from days of normal use
          (last 30 days count).</p>
      </div>
    );
  }
  return (
    <>
      <p class="muted small">From normal use over the last 30 days, grouped by settings the app reads itself. Each day counts once.
        {type === 'draining' && ' Screen-off is the fair comparison; screen-on depends mostly on what you do.'}</p>
      <ul class="results">
        {usable.map((st) => {
          const off = st.off?.median;
          const on = st.on?.median;
          const idle = st.off ? predict(st.off, from, to) : null;
          return (
            <li class={`card config-card tappable ${picked.includes(st.config) ? 'picked' : ''}`} role="button" onClick={() => pick(st.config)}>
              <div class="cc-head">
                <span class="cc-code">{displayCode(st.config, allConfigs)}</span>
                <span class="cc-name">{describeConfig(st.config)}</span>
              </div>
              {type === 'draining' ? (
                <div class="stat-row two">
                  <div><span class="muted small">Screen off</span><b>{off != null ? `${off.toFixed(1)} %/h` : '–'}</b></div>
                  <div><span class="muted small">Screen on (your use)</span><b>{on != null ? `${on.toFixed(1)} %/h` : '–'}</b></div>
                </div>
              ) : (
                <div class="cc-stats"><div><b>{st.all.median!.toFixed(1)}</b><span class="muted small"> %/h median</span></div></div>
              )}
              <div class="muted small">{st.days} day{st.days === 1 ? '' : 's'}</div>
              {type === 'draining' && idle && (
                <div class="cc-predict">Idle {from}% → {to}% ≈ <b>{formatHours(idle.hours)}</b>
                  <span class="muted small"> predicted{idle.extrapolated ? ', partly extrapolated' : ''}</span></div>
              )}
              {type === 'charging' && (() => {
                const p = predict(st.all, from, to);
                return p && <div class="cc-predict">{from}% → {to}% ≈ <b>{formatHours(p.hours)}</b></div>;
              })()}
            </li>
          );
        })}
      </ul>
      {pair && pair[0] && pair[1] && (() => {
        const a = type === 'draining' ? pair[0].off : pair[0].all;
        const b = type === 'draining' ? pair[1].off : pair[1].all;
        if (!a || !b) return <div class="card"><p class="muted">One of these has no {type === 'draining' ? 'screen-off ' : ''}data yet.</p></div>;
        return <ComparisonCard type={type} a={a} b={b} allConfigs={allConfigs}
          note={type === 'draining' ? 'Compared on screen-off (idle) drain only; days count as tests.' : 'Days count as tests.'} />;
      })()}
    </>
  );
}

export function describeConfig(key: string): string {
  return key.split(';').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=') as [string, string];
    switch (k) {
      case 'network_mode': return v.toUpperCase();
      case 'mobile_data': return `data ${v}`;
      case 'power_saving': return `power saving ${v}`;
      case 'perf_profile': return v;
      default: {
        let label = k;
        try { label = getParam(k).label.toLowerCase(); } catch { /* unknown key */ }
        return `${label} ${v}`;
      }
    }
  }).join(' · ') || 'All tests';
}

function ConfigCard({ st, type, code, picked, onPick }: {
  st: ConfigStats; type: TestType; code: string; picked: boolean; onPick: () => void;
}) {
  const [from, to] = PREDICT[type];
  const p = predict(st, from, to);
  const n = st.sessions.length;
  return (
    <li class={`card config-card tappable ${picked ? 'picked' : ''}`} role="button" aria-pressed={picked} onClick={onPick}>
      <div class="cc-head">
        <span class="cc-code">{code}</span>
        <span class="cc-name">{describeConfig(st.config)}</span>
      </div>
      <div class="cc-stats">
        <div><b>{st.median!.toFixed(1)}</b><span class="muted small"> %/h median</span></div>
        <div class="muted small">{n === 1 ? '1 test' : `${n} tests · ${st.min!.toFixed(1)}–${st.max!.toFixed(1)} %/h`}</div>
      </div>
      {p && (
        <div class="cc-predict">
          {from}% → {to}% ≈ <b>{formatHours(p.hours)}</b>
          <span class="muted small"> predicted{p.extrapolated ? ', partly extrapolated' : ''}</span>
        </div>
      )}
      {n < 3 && <div class="cc-note">{n === 1 ? 'One test: a first indication only.' : 'Two tests: run a third to firm this up.'}</div>}
    </li>
  );
}

const VERDICT_TITLE: Record<Comparison['verdict'], string> = {
  insufficient: 'Not enough data yet',
  no_difference: 'No meaningful difference',
  leaning: 'Leaning one way',
  clear: 'Clear difference',
};

function ComparisonCard({ type, a, b, allConfigs, note }: { type: TestType; a: ConfigStats; b: ConfigStats; allConfigs: string[]; note?: string }) {
  const c = compare(type, a, b);
  const nameA = displayCode(a.config, allConfigs);
  const nameB = displayCode(b.config, allConfigs);
  const winner = c.better === 'a' ? nameA : c.better === 'b' ? nameB : null;
  const pct = c.diff != null ? Math.round(Math.abs(c.diff) * 100) : null;
  // The better one drains slower (draining) or charges faster (charging).
  const phrase = type === 'draining' ? 'drains about' : 'charges about';
  const how = type === 'draining' ? 'slower' : 'faster';
  return (
    <div class={`card comparison ${c.verdict}`}>
      <h3>{nameA} vs {nameB}</h3>
      <div class="verdict">{VERDICT_TITLE[c.verdict]}</div>
      {winner && pct != null && (
        <p><b>{winner}</b> {phrase} <b>{pct}%</b> {how} than {winner === nameA ? nameB : nameA}
          {c.verdict === 'leaning' && ' (not confirmed yet)'}.</p>
      )}
      {c.verdict === 'no_difference' && pct != null && <p>They differ by only about {pct}%.</p>}
      {c.matchedBands.length > 0 && (
        <p class="muted small">Compared over the same battery ranges: {c.matchedBands.sort((x, y) => y - x).map((k) => `${k * 10}–${k * 10 + 10}%`).join(', ')}.</p>
      )}
      {c.reasons.length > 0 && <ul class="reasons">{c.reasons.map((r) => <li>{r}</li>)}</ul>}
      {note && <p class="muted small">{note}</p>}
    </div>
  );
}
