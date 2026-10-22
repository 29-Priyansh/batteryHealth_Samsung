import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BatteryLab, type SessionRow } from '../native/batteryLab';
import { useBackHandler } from './backStack';
import { formatHours, Icon, Segmented } from './components';
import { installReach } from './reachability';
import { SessionDetail } from './SessionDetail';
import { fmtDateTime } from './time';

export type SessionItem = SessionRow & { sample_count: number; change_count: number };
export type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

export const STATUS_LABEL: Record<string, string> = {
  active: 'recording', paused: 'paused', stopped: 'stopped',
  target_reached: 'target reached', threshold_reached: 'finished', held_at_limit: 'held by protection',
};

export function SessionCard({ s, onOpen }: { s: SessionItem; onOpen: () => void }) {
  const took = s.end_wall != null ? formatHours((Number(s.end_wall) - Number(s.start_wall)) / 3.6e6) : null;
  return (
    <li class="card session tappable" role="button" tabIndex={0} onClick={onOpen}>
      <div class={`session-icon ${s.type}`}><Icon name={s.type === 'charging' ? 'bolt' : 'drain'} size={18} /></div>
      <div class="session-main">
        <div><b>{s.start_level}% → {s.end_level ?? '…'}%</b>{took && <> · took <b>{took}</b></>}</div>
        <div class="muted small">
          {fmtDateTime(Number(s.start_wall))}
          {s.change_count > 0 && ` · ${s.change_count} change${s.change_count === 1 ? '' : 's'}`}
        </div>
      </div>
      <span class={`status ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status.replace('_', ' ')}</span>
      <span class="chevron" aria-hidden="true">›</span>
    </li>
  );
}

/** Full list of tests with a type filter; opened from "See all". */
export function HistoryPage({ activeId, act, onClose }: { activeId?: string; act: Act; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'charging' | 'draining'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  useBackHandler(onClose);

  const load = () => BatteryLab.listSessions().then((r) => setSessions(r.sessions));
  useEffect(() => { void load(); }, []);

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

  const shown = (sessions ?? []).filter((s) => filter === 'all' || s.type === filter);

  return createPortal(
    <div ref={pageRef} class="detail-page" role="dialog" aria-label="All tests">
      <div class="detail-bar">
        <button class="icon-btn" aria-label="Back" onClick={onClose}><Icon name="back" size={22} /></button>
        <h2>All tests</h2>
      </div>
      <div class="detail-body">
        <Segmented options={['all', 'draining', 'charging'] as const} value={filter} onChange={setFilter}
          label={(f) => (f === 'all' ? 'All' : f === 'charging' ? 'Charging' : 'Draining')} />
        {sessions == null ? <p class="muted center">Loading…</p>
          : shown.length === 0 ? <p class="muted center">No tests yet.</p>
          : <ul class="sessions">{shown.map((s) => <SessionCard s={s} onOpen={() => setOpenId(s.id)} />)}</ul>}
      </div>
      {openId && (
        <SessionDetail id={openId} canDelete={openId !== activeId} act={act}
          onClose={() => { setOpenId(null); void load(); }} />
      )}
    </div>,
    document.body,
  );
}
