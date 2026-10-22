import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getParam } from '../engine/params';
import { changeLog, startingValues, summarize, type ChangeEntry, type SessionSummary } from '../engine/summary';
import { BatteryLab, type SessionData } from '../native/batteryLab';
import { useBackHandler } from './backStack';
import { installReach } from './reachability';
import { formatHours, Icon, Sheet, toast } from './components';
import { exportJson, forgetSession, samplesCsv, saveExport, stamp } from './data';
import { LevelChart } from './LevelChart';
import { loadSetting } from './settingsStore';
import { fmtDateTime, fmtTime } from './time';
import { DEFAULT_SELECTION } from '../engine/params';

const SRC: Record<string, [string, string]> = {
  verified: ['✓', 'Read from the phone'],
  user_confirmed: ['you', 'Confirmed by you'],
  inferred: ['~', 'Inferred'],
  unknown: ['?', 'Unknown'],
};

const END_REASON: Record<string, string> = {
  target_reached: 'Reached the target',
  held_at_limit: 'Stopped charging below the target (battery protection)',
  threshold_reached: 'Reached the discharge level',
  stopped: 'Stopped by you',
  active: 'Still recording',
  paused: 'Paused',
};

export function SessionDetail({ id, canDelete, act, onClose }: {
  id: string; canDelete: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; onClose: () => void;
}) {
  const [data, setData] = useState<SessionData | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useBackHandler(onClose);
  const pageRef = useRef<HTMLDivElement>(null);

  // One-handed mode on this page too; the back button rides down with the content.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const reach = installReach({
      root: page,
      scrollTop: () => page.scrollTop,
      header: () => page.querySelector('.detail-bar'),
      title: () => page.querySelector('.detail-bar h2'),
      content: () => page.querySelector('.detail-body'),
      followers: () => Array.from(page.querySelectorAll<HTMLElement>('.detail-bar .icon-btn')),
      ignore: '.scrim',
    });
    return () => reach.destroy();
  }, []);

  const name = () => `battery-lab-${data!.session.type}-${stamp(Number(data!.session.start_wall))}`;
  const exportCsv = () => saveExport(`${name()}.csv`, 'text/csv', samplesCsv([data!]));
  const exportFull = async () => {
    const selection = {
      charging: await loadSetting('selection.charging', DEFAULT_SELECTION.slice()),
      draining: await loadSetting('selection.draining', DEFAULT_SELECTION.slice()),
    };
    await saveExport(`${name()}.json`, 'application/json', exportJson([data!], selection));
  };

  useEffect(() => {
    BatteryLab.getSessionData({ id }).then(setData).catch((e) => { toast(String(e)); onClose(); });
  }, [id]);

  return createPortal(
    <div ref={pageRef} class="detail-page" role="dialog" aria-label="Test details">
      <div class="detail-bar">
        <button class="icon-btn" aria-label="Back" onClick={onClose}><Icon name="back" size={22} /></button>
        <h2>Test details</h2>
      </div>
      <div class="detail-body">
        {data ? <Detail data={data} /> : <p class="muted center">Loading…</p>}
        {data && (
          <div class="actions">
            <button onClick={exportCsv}>Export CSV</button>
            <button onClick={exportFull}>Export JSON</button>
            {canDelete && <button class="danger" onClick={() => setConfirmDelete(true)}>Delete test</button>}
          </div>
        )}
      </div>
      {confirmDelete && (
        <Sheet title="Delete this test?" onClose={() => setConfirmDelete(false)}>
          <p>This permanently removes the test and all of its raw observations.</p>
          <div class="actions stack">
            <button class="danger" onClick={() => act(async () => {
              await BatteryLab.deleteSession({ id });
              forgetSession(id);
              setConfirmDelete(false);
              onClose();
            }, 'Test deleted')}>Delete</button>
            <button class="ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </Sheet>
      )}
    </div>,
    document.body,
  );
}

function Detail({ data }: { data: SessionData }) {
  const s = data.session;
  const summary = summarize(s, data.samples, data.events);
  const start = startingValues(data.configStates, data.paramValues);
  const tracked: string[] = JSON.parse(String(s.tracked_params ?? '[]'));
  const changes = changeLog(data.configChanges);
  const known = (k: string) => { try { getParam(k); return true; } catch { return false; } };

  return (
    <>
      <div class={`card summary ${s.type}`}>
        <div class="live-head">
          <span class={`tag ${s.type}`}><Icon name={s.type === 'charging' ? 'bolt' : 'drain'} size={14} /> {s.type}</span>
          <span class="muted small">{fmtDateTime(Number(s.start_wall))}</span>
        </div>
        <Headline summary={summary} />
        <div class="muted small">{END_REASON[String(s.status)] ?? String(s.status).replace('_', ' ')}
          {s.end_wall != null && ` at ${fmtTime(Number(s.end_wall))}`}</div>
        <div class="stat-row">
          <div><span class="muted small">{s.type === 'charging' ? 'Charging' : 'Discharging'}</span><b>{formatHours(summary.activeMs / 3.6e6)}</b></div>
          <div><span class="muted small">Interrupted</span><b>{formatHours(summary.interruptedMs / 3.6e6)}</b></div>
          <div><span class="muted small">Average</span><b>{summary.averageRate != null ? `${summary.averageRate.toFixed(1)} %/h` : '–'}</b></div>
        </div>
        {(summary.pausedMs > 0 || summary.gapMs > 0) && (
          <p class="muted small">
            {summary.pausedMs > 0 && `Paused ${formatHours(summary.pausedMs / 3.6e6)}. `}
            {summary.gapMs > 0 && `Not observed for ${formatHours(summary.gapMs / 3.6e6)} (app stopped or phone restarted).`}
          </p>
        )}
        <p class="muted small">"Average" is the overall percentage points per {s.type === 'charging' ? 'charging' : 'discharging'} hour. It mixes any configurations used during the test.</p>
        {s.notes && <p class="notes">“{s.notes}”</p>}
      </div>

      <div class="card">
        <h3 class="section-h">Battery level</h3>
        <LevelChart session={s} samples={data.samples} changes={data.configChanges} />
      </div>

      <div class="card">
        <h3 class="section-h">Settings at the start</h3>
        {start.length === 0 ? <p class="muted small">Not recorded for this test.</p> : (
          <ul class="config">
            {start.filter((v) => known(v.key))
              .sort((a, b) => Number(tracked.includes(b.key)) - Number(tracked.includes(a.key)))
              .map((v) => {
                const [mark, title] = SRC[v.src] ?? ['?', v.src];
                return (
                  <li class={tracked.includes(v.key) ? '' : 'condition'}>
                    <span>{getParam(v.key).label}</span>
                    <span><b>{v.value ?? 'unknown'}</b> <span class={`src ${v.src}`} title={title}>{mark}</span></span>
                  </li>
                );
              })}
          </ul>
        )}
      </div>

      <div class="card">
        <h3 class="section-h">Setting changes</h3>
        {changes.length === 0
          ? <p class="muted small">No settings changed during this test.</p>
          : <ol class="timeline">{changes.filter((c) => known(c.param)).map((c) => <ChangeItem c={c} start={Number(s.start_wall)} />)}</ol>}
      </div>
    </>
  );
}

function Headline({ summary }: { summary: SessionSummary }) {
  const verb = summary.type === 'charging' ? 'Charging' : 'Draining';
  return (
    <div class="headline">
      <div class="big">{formatHours(summary.totalMs / 3.6e6)}</div>
      <div>
        {verb} <b>{summary.startLevel ?? '?'}% → {summary.endLevel ?? '?'}%</b> {summary.finished ? 'took' : 'so far'}{' '}
        <b>{formatHours(summary.totalMs / 3.6e6)}</b>
      </div>
    </div>
  );
}

function ChangeItem({ c, start }: { c: ChangeEntry; start: number }) {
  const time = fmtTime(c.wall);
  return (
    <li class={c.source}>
      <div class="tl-meta">{time} · {formatHours((c.wall - start) / 3.6e6)} in</div>
      <div class="tl-title">{getParam(c.param).label}</div>
      <div class="tl-change">
        <span class="tl-old">{c.from ?? 'unknown'}</span>
        <span class="tl-arrow" aria-hidden="true">→</span>
        <span class="tl-new">{c.to ?? 'unknown'}</span>
      </div>
      <div class="tl-source">
        {c.source === 'auto' ? 'Detected automatically' : 'Logged by you'}
        {c.windowMin > 0 && ` · changed up to ${c.windowMin} min earlier`}
      </div>
    </li>
  );
}
