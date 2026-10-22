// Loading sessions for Results/History and exporting them. Raw rows are exported unchanged;
// computed values carry the estimator version so they can be recomputed later (§10).

import { aggregate, sessionRates } from '../engine/compare';
import { computePriors } from '../engine/everyday';
import { DEFAULT_SELECTION, type TestType } from '../engine/params';
import { ESTIMATOR_VERSION, extractSteps, type SessionRows } from '../engine/steps';
import { loadSetting, saveSetting } from './settingsStore';
import { summarize, type RawRow } from '../engine/summary';
import { BatteryLab, type SessionData } from '../native/batteryLab';
import { toast } from './components';

// Session data rarely changes once a test has ended, so keep it keyed by its row count.
const cache = new Map<string, { samples: number; data: SessionData }>();

export async function loadSessions(): Promise<SessionData[]> {
  const { sessions } = await BatteryLab.listSessions();
  return Promise.all(sessions.map(async (s) => {
    const hit = cache.get(s.id);
    if (hit && hit.samples === s.sample_count && s.end_wall != null) return hit.data;
    const data = await BatteryLab.getSessionData({ id: s.id });
    cache.set(s.id, { samples: s.sample_count, data });
    return data;
  }));
}

export async function loadSelection(): Promise<Record<TestType, string[]>> {
  return {
    charging: await loadSetting('selection.charging', DEFAULT_SELECTION.slice()),
    draining: await loadSetting('selection.draining', DEFAULT_SELECTION.slice()),
  };
}

/** Recomputes each configuration's history and hands it to the recorder for the live estimate. */
export async function updatePriors(data?: SessionData[]) {
  const all = data ?? await loadSessions();
  const priors = computePriors(all as unknown as SessionRows[], await loadSelection());
  await saveSetting('priors', priors);
}

export function forgetSession(id: string) {
  cache.delete(id);
}

// ---------------------------------------------------------------- export

const SAMPLE_COLUMNS = [
  'session_id', 'time', 'wall_ms', 'elapsed_ms', 'boot_count', 'level', 'status', 'plugged', 'temp_c', 'voltage_mv',
  'charge_counter_uah', 'current_now_raw', 'current_avg_raw', 'screen_on', 'brightness', 'radio', 'signal_level', 'reason', 'flags',
];

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per observation, with the settings in force at that moment as extra columns. */
export function samplesCsv(list: SessionData[]): string {
  const paramKeys = [...new Set(list.flatMap((d) => d.paramValues.map((p) => String(p.param_key))))].sort();
  const lines = [[...SAMPLE_COLUMNS, ...paramKeys].join(',')];
  for (const d of list) {
    const byState = new Map<number, Record<string, unknown>>();
    for (const p of d.paramValues) {
      const m = byState.get(Number(p.config_state_id)) ?? {};
      m[String(p.param_key)] = p.value;
      byState.set(Number(p.config_state_id), m);
    }
    for (const s of d.samples) {
      const params = byState.get(Number(s.config_state_id)) ?? {};
      const row: unknown[] = [
        d.session.id, new Date(Number(s.wall_ms)).toISOString(), s.wall_ms, s.elapsed_ms, s.boot_count, s.level, s.status,
        s.plugged, s.temp_dc == null ? null : Number(s.temp_dc) / 10, s.voltage_mv, s.charge_counter_uah, s.current_now_raw,
        s.current_avg_raw, s.screen_on, s.brightness, s.radio, s.signal_level, s.reason, s.flags,
        ...paramKeys.map((k) => params[k]),
      ];
      lines.push(row.map(csvCell).join(','));
    }
  }
  return lines.join('\n');
}

/** Raw tables plus computed summaries and rates, tagged with the estimator version. */
export function exportJson(list: SessionData[], selection: Record<string, readonly string[]>): string {
  const steps = list.map((d) => extractSteps(d as unknown as Parameters<typeof extractSteps>[0], selection[String(d.session.type)] ?? []));
  return JSON.stringify({
    format: 'battery-lab-export',
    exportedAt: new Date().toISOString(),
    estimatorVersion: ESTIMATOR_VERSION,
    selection,
    sessions: list.map((d, i) => ({
      raw: d,
      summary: summarize(d.session as RawRow, d.samples, d.events),
      rates: sessionRates(steps[i]!),
      excluded: steps[i]!.excluded,
    })),
    configurations: {
      charging: aggregate(steps.filter((s) => s.type === 'charging')),
      draining: aggregate(steps.filter((s) => s.type === 'draining')),
    },
  }, null, 1);
}

export async function saveExport(filename: string, mime: string, content: string) {
  try {
    await BatteryLab.saveFile({ filename, mime, content });
    toast('Saved');
  } catch (e) {
    if (!String(e).includes('cancelled')) toast(String(e).replace(/^Error: /, ''));
  }
}

export function stamp(ms = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
