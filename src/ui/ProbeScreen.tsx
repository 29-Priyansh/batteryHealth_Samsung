import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'preact/hooks';
import { BatteryLab, type BroadcastStats, type PermissionState, type ProbeReport } from '../native/batteryLab';

export function ProbeScreen() {
  const [perms, setPerms] = useState<PermissionState | null>(null);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [stats, setStats] = useState<BroadcastStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const native = Capacitor.isNativePlatform();

  const refreshPerms = async () => setPerms(await BatteryLab.getPermissions());
  useEffect(() => { if (native) void refreshPerms(); }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };

  if (!native) return <p class="muted">The capability probe only runs on the phone.</p>;

  const copy = async () => {
    const text = JSON.stringify({ report, broadcastStats: stats }, null, 2);
    try { await navigator.clipboard.writeText(text); alert('Copied'); } catch { alert('Copy failed'); }
  };

  return (
    <section>
      <p class="muted">Milestone 0: checks what this phone's public APIs actually report. Nothing is changed on the device.</p>

      <div class="card">
        <h3>Permissions & access</h3>
        {perms && (
          <ul class="perms">
            <Perm ok={perms.phoneState} label="Phone state (mobile data, radio type)" action={() => run('perm', async () => setPerms(await BatteryLab.requestPhoneState()))} />
            <Perm ok={perms.notifications} label="Notifications (monitoring status)" action={() => run('perm', async () => setPerms(await BatteryLab.requestNotifications()))} />
            <Perm ok={perms.ignoringBatteryOptimizations} label="Battery: Unrestricted" action={() => BatteryLab.openBatteryOptimization()} />
            <Perm ok={perms.usageAccess} label="Usage access (optional: recover screen events)" action={() => BatteryLab.openUsageAccess()} />
          </ul>
        )}
        <button class="small" onClick={() => run('perm', refreshPerms)}>Refresh</button>
      </div>

      <div class="actions">
        <button class="primary" disabled={!!busy} onClick={() => run('probe', async () => setReport(await BatteryLab.probe()))}>
          {busy === 'probe' ? 'Probing…' : 'Run probe'}
        </button>
        <button disabled={!!busy} onClick={() => run('bc', async () => setStats(await BatteryLab.sampleBroadcasts({ seconds: 120 })))}>
          {busy === 'bc' ? 'Counting broadcasts (2 min)…' : 'Measure broadcast rate'}
        </button>
        {report && <button onClick={copy}>Copy JSON</button>}
      </div>
      {error && <p class="error">{error}</p>}

      {stats && (
        <div class="card">
          <h3>Battery broadcasts in {stats.seconds}s</h3>
          <p>{stats.broadcasts} broadcasts — level changed {stats.levelChanges}×, voltage {stats.voltageChanges}×, temperature {stats.temperatureChanges}×, status {stats.statusChanges}×.</p>
        </div>
      )}

      {report && Object.entries(report).map(([section, fields]) => (
        <div class="card">
          <h3>{section}</h3>
          <table class="kv">
            <tbody>
              {Object.entries(fields).map(([k, v]) => (
                <tr><td>{k}</td><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function Perm({ ok, label, action }: { ok: boolean; label: string; action: () => void }) {
  return (
    <li>
      <span class={ok ? 'ok' : 'bad'}>{ok ? '✓' : '✗'}</span> {label}
      {!ok && <button class="small" onClick={action}>Fix</button>}
    </li>
  );
}
