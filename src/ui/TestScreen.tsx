import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'preact/hooks';
import { applicable, DEFAULT_SELECTION, getParam, type ParamDef, type TestType } from '../engine/params';
import { BatteryLab, type CurrentState, type LiveEstimate, type SessionRow } from '../native/batteryLab';
import { ChipGroup, clockIn, formatElapsed, formatHours, Gauge, Icon, LevelPicker, Segmented, Sheet, toast } from './components';
import { SessionDetail } from './SessionDetail';
import { loadSetting, saveSetting } from './settingsStore';

const STATUS: Record<number, string> = { 1: 'Unknown', 2: 'Charging', 3: 'Discharging', 4: 'Plugged in, not charging', 5: 'Full' };
const SRC_BADGE: Record<string, [string, string]> = {
  verified: ['✓', 'Read from the phone'],
  user_confirmed: ['you', 'Confirmed by you'],
  inferred: ['~', 'Inferred'],
  unknown: ['?', 'Unknown'],
};

type SessionItem = SessionRow & { sample_count: number; change_count: number };
type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

export function TestScreen() {
  const [state, setState] = useState<CurrentState | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  const refresh = async () => {
    try {
      setState(await BatteryLab.getCurrentState());
      setSessions((await BatteryLab.listSessions()).sessions);
    } catch (e) { toast(String(e)); }
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void refresh();
    const sub = BatteryLab.addListener('sampleAdded', () => void refresh());
    // While visible, refresh the instant estimate once a minute (no background polling).
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      void sub.then((h) => h.remove());
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!Capacitor.isNativePlatform()) return <p class="muted center">Tests only run on the phone.</p>;
  if (!state) return <p class="muted center">Loading…</p>;

  const act: Act = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) { toast(String(e).replace(/^Error: /, '')); }
    await refresh();
  };

  const b = state.battery;
  return (
    <section>
      <div class="card hero">
        {b ? <Gauge level={b.level} charging={b.status === 2} /> : <div class="gauge" />}
        <div class="hero-info">
          <div class="hero-status">{b ? STATUS[b.status] ?? `Status ${b.status}` : 'Battery unavailable'}</div>
          {b && <div class="muted">{b.tempC.toFixed(1)} °C · {(b.voltageMv / 1000).toFixed(2)} V</div>}
          <div class="pills">
            {Object.entries(state.auto).filter(([, v]) => v != null).map(([k, v]) => (
              <span class="pill">{getParam(k).label} <b>{v}</b></span>
            ))}
            {state.radio && <span class="pill">Radio <b>{state.radio.replace('_', ' ')}</b></span>}
          </div>
        </div>
      </div>

      {state.activeSession
        ? <ActiveSession state={state} act={act} />
        : <StartForm act={act} level={b?.level ?? null} />}

      <SessionList sessions={sessions} activeId={state.activeSession?.id} act={act} onChanged={() => void refresh()} />
    </section>
  );
}

// ---------------------------------------------------------------- active session

function ActiveSession({ state, act }: { state: CurrentState; act: Act }) {
  const s = state.activeSession!;
  const tracked: string[] = JSON.parse(String(s.tracked_params ?? '[]'));
  const manualParams = applicable(tracked, s.type).filter((p) => p.detection === 'manual');
  const paused = s.status === 'paused';
  const [now, setNow] = useState(Date.now());
  const [sheet, setSheet] = useState<'log' | 'stop' | 'limit' | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <div class={`card live ${paused ? 'paused' : ''}`}>
        <div class="live-head">
          <span class={`tag ${s.type}`}><Icon name={s.type === 'charging' ? 'bolt' : 'drain'} size={14} /> {s.type}</span>
          <span class={`dot ${paused ? '' : 'pulse'}`} />
          <span class="muted">{paused ? 'Paused' : 'Recording'} · {formatElapsed(now - Number(s.start_wall))}</span>
        </div>
        <div class="range-row">
          <span>{s.type === 'charging' ? 'Charging' : 'Discharging'} <b>{state.battery?.level ?? '?'}% → {s.type === 'charging' ? s.target_level : s.lower_threshold}%</b></span>
          <button class="small" onClick={() => setSheet('limit')}>Change</button>
        </div>
        <LiveBlock live={state.live} type={s.type} />
        <div class="muted small">
          Started at {s.start_level}%{state.counts && ` · ${state.counts.samples} observations`}
          {state.counts && state.counts.changes > 0 && ` · ${state.counts.changes} setting changes`}
        </div>
        <div class="actions">
          <button onClick={() => act(() => paused ? BatteryLab.resumeSession() : BatteryLab.pauseSession(), paused ? 'Resumed' : 'Paused')}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          {manualParams.length > 0 && <button onClick={() => setSheet('log')}>Log change</button>}
          <button class="danger" onClick={() => setSheet('stop')}>Stop</button>
        </div>
      </div>

      <div class="card">
        <h3>Configuration</h3>
        <ul class="config">
          {Object.entries(state.activeValues ?? {})
            .sort(([a], [b]) => Number(tracked.includes(b)) - Number(tracked.includes(a)))
            .map(([k, v]) => {
              const [mark, title] = SRC_BADGE[v.src] ?? ['?', v.src];
              return (
                <li class={tracked.includes(k) ? '' : 'condition'}>
                  <span>{getParam(k).label}</span>
                  <span><b>{v.value ?? 'unknown'}</b> <span class={`src ${v.src}`} title={title}>{mark}</span></span>
                </li>
              );
            })}
        </ul>
        <p class="muted small">Faded rows are recorded as conditions only; they don't define the configuration.</p>
      </div>

      {sheet === 'log' && <LogChangeSheet params={manualParams} current={state.activeValues ?? {}} act={act} onClose={() => setSheet(null)} />}
      {sheet === 'limit' && (
        <LimitSheet type={s.type} level={state.battery?.level ?? null}
          current={Number(s.type === 'charging' ? s.target_level : s.lower_threshold)} act={act} onClose={() => setSheet(null)} />
      )}
      {sheet === 'stop' && <StopSheet manualParams={manualParams} act={act} onClose={() => setSheet(null)} />}
    </>
  );
}

function LiveBlock({ live, type }: { live: LiveEstimate | null; type: TestType }) {
  if (!live) return <div class="estimate"><div class="big">–</div></div>;
  const wanted = type === 'charging' ? 1 : -1;
  if (live.direction !== wanted) {
    return <div class="estimate"><div class="big muted">Not counted</div><div class="muted">{live.summary}</div></div>;
  }
  const quality = live.ratePerHour == null ? 'Measuring' : live.measured ? `Measured · ${live.steps} steps` : `Early estimate · ${live.steps} step${live.steps === 1 ? '' : 's'}`;
  return (
    <div class="estimate">
      <div class="big">{live.hoursToLimit != null ? formatHours(live.hoursToLimit) : live.ratePerHour == null ? 'Measuring…' : '–'}</div>
      <div>{live.hoursToLimit != null
        ? <>to {live.limit}% · {type === 'draining' ? 'recharge' : 'done'} around <b>{clockIn(live.hoursToLimit)}</b></>
        : live.ratePerHour == null ? 'Waiting for the next 1% change' : ''}</div>
      <div class="stat-row">
        <div><span class="muted small">Rate</span><b>{live.ratePerHour != null ? `${live.ratePerHour.toFixed(1)} %/h` : '–'}</b></div>
        <div><span class="muted small">Instant ({live.instantMa ?? '–'} mA)</span><b>{formatHours(live.instantHours)}</b></div>
        <div><span class="muted small">Quality</span><b class={live.measured ? 'ok' : 'warn'}>{quality}</b></div>
      </div>
      <p class="muted small">"Rate" comes from completed 1% steps in this configuration; "Instant" comes from the current draw right now and swings with use. Both assume nothing changes.</p>
    </div>
  );
}

function LogChangeSheet({ params, current, act, onClose }: {
  params: ParamDef[]; current: Record<string, { value: string | null }>; act: Act; onClose: () => void;
}) {
  const [param, setParam] = useState(params[0]!.key);
  const [chargers, setChargers] = useState<string[]>([]);
  useEffect(() => { void loadSetting<string[]>('chargers', []).then(setChargers); }, []);
  const def = params.find((p) => p.key === param)!;
  const levels = def.key === 'charger' ? chargers : def.levels;

  const log = (value: string | null) => act(async () => {
    await BatteryLab.logChange({ param, value });
    onClose();
  }, `${def.label} → ${value ?? 'unknown'} logged`);

  return (
    <Sheet title="Log a setting change" onClose={onClose}>
      <p class="muted small">Do this right after changing the setting. Time you spent outside the app (up to 30 min) is stored as the uncertainty window, and the 1% step that crosses it is left out of both configurations.</p>
      <label class="field-label">Setting</label>
      <ChipGroup options={params.map((p) => p.key)} value={param} onChange={setParam} label={(k) => getParam(k).label} />
      <label class="field-label">New value <span class="muted">(now: {current[param]?.value ?? 'unknown'})</span></label>
      <div class="chips">
        {levels.filter((l) => l !== current[param]?.value).map((l) => <button class="chip" onClick={() => log(l)}>{l}</button>)}
        <button class="chip ghost" onClick={() => log(null)}>Not sure</button>
      </div>
    </Sheet>
  );
}

function LimitSheet({ type, level, current, act, onClose }: {
  type: TestType; level: number | null; current: number; act: Act; onClose: () => void;
}) {
  const [value, setValue] = useState(current);
  const error = level == null ? null
    : type === 'charging' && value <= level ? `Pick a target above the current ${level}%.`
    : type === 'draining' && value >= level ? `Pick a level below the current ${level}%.`
    : null;
  return (
    <Sheet title={type === 'charging' ? 'Charge until' : 'Discharge down to'} onClose={onClose}>
      <LevelPicker presets={type === 'charging' ? [80, 85, 90, 100] : [10, 15, 20, 30, 50]}
        value={value} onChange={setValue} min={type === 'charging' ? 2 : 1} max={type === 'charging' ? 100 : 99} />
      {level != null && (
        <div class={`range-summary ${error ? 'bad' : ''}`}>
          {error ?? <>New range <b>{level}% → {value}%</b> · {Math.abs(level - value)} points left</>}
        </div>
      )}
      <p class="muted small">Only the stopping point changes. Data recorded so far is kept as is.</p>
      <div class="actions stack">
        <button class="primary" disabled={error != null || value === current} onClick={() => act(async () => {
          await BatteryLab.setLimit({ value });
          onClose();
        }, `Test now ends at ${value}%`)}>Save</button>
        <button class="ghost" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

function StopSheet({ manualParams, act, onClose }: { manualParams: ParamDef[]; act: Act; onClose: () => void }) {
  const stop = (manualUnchanged: boolean | null) => act(async () => {
    await BatteryLab.stopSession({ confirmations: { manualUnchanged } });
    onClose();
  }, 'Test stopped');
  return (
    <Sheet title="Stop this test?" onClose={onClose}>
      {manualParams.length > 0 ? (
        <>
          <p>Did <b>{manualParams.map((p) => p.label).join(', ')}</b> stay as logged for the whole test?</p>
          <p class="muted small">If you're not sure, the affected time is excluded from configuration comparisons, but the raw data is kept.</p>
          <div class="actions stack">
            <button class="primary" onClick={() => stop(true)}>Yes, stop test</button>
            <button onClick={() => stop(null)}>Not sure, stop test</button>
            <button class="ghost" onClick={onClose}>Keep recording</button>
          </div>
        </>
      ) : (
        <div class="actions stack">
          <button class="primary" onClick={() => stop(true)}>Stop test</button>
          <button class="ghost" onClick={onClose}>Keep recording</button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- start form

function StartForm({ act, level }: { act: Act; level: number | null }) {
  const [type, setType] = useState<TestType>('draining');
  const [selection, setSelection] = useState<Record<TestType, string[]>>({ charging: DEFAULT_SELECTION.slice(), draining: DEFAULT_SELECTION.slice() });
  const [chargers, setChargers] = useState<string[]>([]);
  const [manual, setManual] = useState<Record<string, string | null>>({});
  const [target, setTarget] = useState(80);
  const [threshold, setThreshold] = useState(20);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    (async () => {
      setSelection({
        charging: await loadSetting('selection.charging', DEFAULT_SELECTION.slice()),
        draining: await loadSetting('selection.draining', DEFAULT_SELECTION.slice()),
      });
      setChargers(await loadSetting<string[]>('chargers', []));
      setManual(await loadSetting<Record<string, string | null>>('lastManual', {}));
      setTarget(await loadSetting('lastTarget', 80));
      setThreshold(await loadSetting('lastThreshold', 20));
    })();
  }, []);

  const params = applicable(selection[type], type);
  const manualParams = params.filter((p) => p.detection === 'manual');
  const autoParams = params.filter((p) => p.detection === 'auto');
  const missing = manualParams.filter((p) => !(p.key in manual));
  // The limit must lie ahead of the current level, otherwise the test would end immediately.
  const rangeError = level == null ? null
    : type === 'charging' && target <= level ? `The battery is already at ${level}%. Pick a target above ${level}%.`
    : type === 'draining' && threshold >= level ? `The battery is at ${level}%. Pick a level below ${level}%.`
    : null;
  const span = level == null ? null : type === 'charging' ? target - level : level - threshold;

  const start = () => act(async () => {
    const values = Object.fromEntries(manualParams.map((p) => [p.key, manual[p.key] ?? null]));
    await saveSetting('lastManual', { ...manual });
    await saveSetting(type === 'charging' ? 'lastTarget' : 'lastThreshold', type === 'charging' ? target : threshold);
    await BatteryLab.startSession({
      type,
      target: type === 'charging' ? target : undefined,
      threshold: type === 'draining' ? threshold : undefined,
      manual: values,
      trackedParams: selection[type],
      notes: notes.trim() || undefined,
    });
  }, `${type === 'charging' ? 'Charging' : 'Draining'} test started`);

  return (
    <div class="card">
      <h3>New test</h3>
      <Segmented options={['draining', 'charging'] as const} value={type} onChange={setType}
        label={(t) => (t === 'charging' ? 'Charging' : 'Draining')} />

      {type === 'charging' ? (
        <>
          <label class="field-label">Charge until</label>
          <LevelPicker presets={[80, 85, 90, 100]} value={target} onChange={setTarget} min={2} max={100} />
          <p class="muted small">Plug in after starting. Unplugged and "not charging" time is never counted as charging time.</p>
        </>
      ) : (
        <>
          <label class="field-label">Discharge down to</label>
          <LevelPicker presets={[10, 15, 20, 30, 50]} value={threshold} onChange={setThreshold} min={1} max={99} />
          <p class="muted small">Unplug before starting. Charging time is recorded as an interruption, not as draining.</p>
        </>
      )}

      {level != null && (
        <div class={`range-summary ${rangeError ? 'bad' : ''}`}>
          {rangeError ?? <>Range <b>{level}% → {type === 'charging' ? target : threshold}%</b> · {span} percentage points</>}
        </div>
      )}
      {!rangeError && span != null && span < 5 && (
        <p class="muted small">A range under 5 points gives too few 1% steps for a reliable rate; the result will likely be "insufficient data".</p>
      )}
      {type === 'charging' && target > 80 && !rangeError && (
        <p class="muted small">If Battery protection is on, the phone may stop charging around 80–95%. That time is recorded as "not charging", and the test may never reach {target}%.</p>
      )}

      {manualParams.length > 0 && (
        <>
          <h4>Confirm what the app can't read</h4>
          {manualParams.map((p) => (
            <div class="param-row">
              <div class="param-name">{p.label}</div>
              <ChipGroup
                options={[...(p.key === 'charger' ? chargers : p.levels), '__unsure']}
                value={p.key in manual ? (manual[p.key] ?? '__unsure') : undefined}
                onChange={(v) => setManual((m) => ({ ...m, [p.key]: v === '__unsure' ? null : v }))}
                label={(v) => (v === '__unsure' ? 'Not sure' : v)}
              />
              {p.key === 'charger' && chargers.length === 0 && <p class="muted small">Add your chargers in Setup first.</p>}
            </div>
          ))}
        </>
      )}

      <p class="muted small">Read automatically: {autoParams.map((p) => p.label).join(', ') || 'none selected'}. Every automatic setting is recorded anyway. Change your selection in <b>Setup</b>.</p>

      <label class="field-label">Notes (optional)</label>
      <input class="text" placeholder="e.g. idle overnight, brightness 30%" value={notes}
        onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />

      <div class="actions">
        <button class="primary wide" disabled={missing.length > 0 || rangeError != null} onClick={start}>
          {rangeError ? 'Adjust the range'
            : missing.length > 0 ? `Confirm ${missing.map((p) => p.label).join(', ')}`
            : `Start ${type} test · ${type === 'charging' ? `to ${target}%` : `down to ${threshold}%`}`}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- history

const STATUS_LABEL: Record<string, string> = {
  active: 'recording', paused: 'paused', stopped: 'stopped',
  target_reached: 'target reached', threshold_reached: 'finished',
};

function SessionList({ sessions, activeId, act, onChanged }: {
  sessions: SessionItem[]; activeId?: string; act: Act; onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  return (
    <>
      <h3 class="section-title">Recent tests</h3>
      <ul class="sessions">
        {sessions.map((s) => {
          const ended = s.end_wall != null;
          const took = ended ? formatHours((Number(s.end_wall) - Number(s.start_wall)) / 3.6e6) : null;
          return (
            <li class="card session tappable" role="button" tabIndex={0} onClick={() => setOpenId(s.id)}>
              <div class={`session-icon ${s.type}`}><Icon name={s.type === 'charging' ? 'bolt' : 'drain'} size={18} /></div>
              <div class="session-main">
                <div><b>{s.start_level}% → {s.end_level ?? '…'}%</b>{took && <> · took <b>{took}</b></>}</div>
                <div class="muted small">
                  {new Date(s.start_wall).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  {s.change_count > 0 && ` · ${s.change_count} setting change${s.change_count === 1 ? '' : 's'}`}
                </div>
              </div>
              <span class={`status ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status.replace('_', ' ')}</span>
              <span class="chevron" aria-hidden="true">›</span>
            </li>
          );
        })}
      </ul>
      {openId && (
        <SessionDetail id={openId} canDelete={openId !== activeId} act={act}
          onClose={() => { setOpenId(null); onChanged(); }} />
      )}
    </>
  );
}
