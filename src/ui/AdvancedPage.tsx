import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BatteryLab, type Row } from '../native/batteryLab';
import { useBackHandler } from './backStack';
import { Icon } from './components';
import { ProbeScreen } from './ProbeScreen';
import { installReach } from './reachability';

/** Developer tools moved out of the main tabs: capability probe and the app's own overhead. */
export function AdvancedPage({ onClose }: { onClose: () => void }) {
  const pageRef = useRef<HTMLDivElement>(null);
  useBackHandler(onClose);

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

  return createPortal(
    <div ref={pageRef} class="detail-page" role="dialog" aria-label="Advanced">
      <div class="detail-bar">
        <button class="icon-btn" aria-label="Back" onClick={onClose}><Icon name="back" size={22} /></button>
        <h2>Advanced</h2>
      </div>
      <div class="detail-body">
        <OverheadCard />
        <h3 class="section-title">Diagnostics</h3>
        <ProbeScreen />
      </div>
    </div>,
    document.body,
  );
}

/** The app's own cost while recording (docs/PLAN.md §11): counted in-app, per day. */
function OverheadCard() {
  const [days, setDays] = useState<Row[] | null>(null);
  useEffect(() => { BatteryLab.getOverhead().then((r) => setDays(r.days)).catch(() => setDays([])); }, []);

  return (
    <div class="card">
      <h3>App overhead</h3>
      <p class="muted small">What this app itself did while recording. Battery updates come from Android anyway; the app only decides whether to store them.</p>
      {days == null ? <p class="muted small">Loading…</p> : days.length === 0 ? <p class="muted small">No recording yet.</p> : (
        <table class="kv overhead">
          <thead><tr><td>Day</td><td>Updates</td><td>Rows</td><td>CPU</td></tr></thead>
          <tbody>
            {days.slice(0, 14).map((d) => (
              <tr>
                <td>{String(d.day).slice(5)}</td>
                <td>{Number(d.broadcasts).toLocaleString()}</td>
                <td>{Number(d.rows_written).toLocaleString()}</td>
                <td>{(Number(d.handler_cpu_ns) / 1e9).toFixed(2)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="muted small">Target: under 60 s of CPU and a few hundred rows per day. For Android's own view, run
        {' '}<code>adb shell dumpsys batterystats com.priyansh.batterylab</code>.</p>
    </div>
  );
}
