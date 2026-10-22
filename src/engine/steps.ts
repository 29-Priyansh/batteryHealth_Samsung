// Step extraction (docs/PLAN.md §6): turns one session's raw rows into "complete 1% steps",
// each attributed to exactly one configuration. A step is the time between the first
// observation of level L and the first observation of L±1 inside one uninterrupted run.
// Runs break at: pauses, wrong direction (interruptions), reboots/gaps, configuration
// changes and their uncertainty windows, and jumps of more than one point.

import { configKey, type ParamValue, type TestType } from './params';
import type { RawRow } from './summary';

export const ESTIMATOR_VERSION = 1;
export const BAND_SIZE = 10;

export interface SessionRows {
  session: RawRow;
  samples: RawRow[];
  events: RawRow[];
  configStates: RawRow[];
  paramValues: RawRow[];
  configChanges: RawRow[];
}

export interface Step {
  config: string;
  fromLevel: number;
  toLevel: number;
  durationMs: number;
  /** 10-point battery band index (0 = 0–9%, 9 = 90–100%). */
  band: number;
  screen: 'on' | 'off' | 'mixed' | null;
  maxTempC: number | null;
}

export interface SessionSteps {
  sessionId: string;
  type: TestType;
  startWall: number;
  steps: Step[];
  /** Why observations were not usable, with counts (shown to the user). */
  excluded: Record<string, number>;
}

const CHARGING = 2;
const DISCHARGING = 3;

const directionOf = (s: RawRow) =>
  s.status === CHARGING ? 1 : s.status === DISCHARGING || s.plugged === 0 ? -1 : 0;

export function bandOf(from: number, to: number): number {
  return Math.min(9, Math.max(0, Math.floor(Math.min(from, to) / BAND_SIZE)));
}

/** Configuration key for every config_state row, under the given selection (null = unknown). */
export function configKeysByState(rows: SessionRows, selection: readonly string[], type: TestType): Map<number, string | null> {
  const byState = new Map<number, Record<string, ParamValue>>();
  for (const p of rows.paramValues) {
    const id = Number(p.config_state_id);
    const values = byState.get(id) ?? {};
    values[String(p.param_key)] = { value: p.value == null ? null : String(p.value), src: String(p.src) as ParamValue['src'] };
    byState.set(id, values);
  }
  const out = new Map<number, string | null>();
  for (const st of rows.configStates) {
    const id = Number(st.id);
    out.set(id, configKey(byState.get(id) ?? {}, selection, type));
  }
  return out;
}

/**
 * [type] defaults to the session's own type; everyday (always-on) sessions record both
 * directions, so they are extracted once as 'draining' and once as 'charging'.
 */
export function extractSteps(rows: SessionRows, selection: readonly string[], type: TestType = rows.session.type as TestType): SessionSteps {
  const wanted = type === 'charging' ? 1 : -1;
  const keys = configKeysByState(rows, selection, type);
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };

  // Uncertainty windows of manual changes: observations inside them belong to neither side.
  const windows = rows.configChanges
    .filter((c) => Number(c.window_end_elapsed) > Number(c.window_start_elapsed))
    .map((c) => ({ boot: Number(c.boot_count), from: Number(c.window_start_elapsed), to: Number(c.window_end_elapsed) }));
  const inWindow = (s: RawRow) =>
    windows.some((w) => w.boot === Number(s.boot_count) && Number(s.elapsed_ms) >= w.from && Number(s.elapsed_ms) <= w.to);

  const samples = [...rows.samples].sort((a, b) => Number(a.id) - Number(b.id));
  const steps: Step[] = [];

  interface Run {
    config: string;
    lastLevel: number;
    anchor: { elapsed: number; level: number } | null;
    screens: Set<boolean>;
    maxTemp: number | null;
  }
  let run: Run | null = null;
  let paused = false;
  let prev: RawRow | null = null;

  const track = (r: Run, s: RawRow) => {
    if (s.screen_on != null) r.screens.add(Number(s.screen_on) === 1);
    if (s.temp_dc != null) r.maxTemp = Math.max(r.maxTemp ?? -Infinity, Number(s.temp_dc) / 10);
  };

  for (const s of samples) {
    const restarted = prev != null && (prev.boot_count !== s.boot_count || s.reason === 'recovery');
    prev = s;
    if (s.reason === 'pause') paused = true;
    if (s.reason === 'resume') { paused = false; run = null; continue; }
    if (restarted) { run = null; exclude('app stopped or phone restarted'); }
    if (paused) { run = null; continue; }
    if (directionOf(s) !== wanted) { if (run) exclude(type === 'charging' ? 'not charging' : 'charging'); run = null; continue; }
    if (inWindow(s)) { run = null; exclude('uncertain change time'); continue; }
    const key = keys.get(Number(s.config_state_id)) ?? null;
    if (key == null) { run = null; exclude('setting not confirmed'); continue; }

    const level = Number(s.level);
    if (!run || run.config !== key) {
      // First level of a run is partial: its entry time is unknown.
      run = { config: key, lastLevel: level, anchor: null, screens: new Set(), maxTemp: null };
      continue;
    }
    if (level === run.lastLevel) { track(run, s); continue; }
    const delta = level - run.lastLevel;
    run.lastLevel = level;
    if (Math.abs(delta) !== 1 || Math.sign(delta) !== wanted) {
      exclude('battery level jumped');
      run.anchor = { elapsed: Number(s.elapsed_ms), level };
      run.screens = new Set(); run.maxTemp = null;
      track(run, s);
      continue;
    }
    if (run.anchor) {
      track(run, s);
      const screen = run.screens.size === 0 ? null : run.screens.size > 1 ? 'mixed' : run.screens.has(true) ? 'on' : 'off';
      steps.push({
        config: run.config,
        fromLevel: run.anchor.level,
        toLevel: level,
        durationMs: Number(s.elapsed_ms) - run.anchor.elapsed,
        band: bandOf(run.anchor.level, level),
        screen,
        maxTempC: run.maxTemp,
      });
    }
    run.anchor = { elapsed: Number(s.elapsed_ms), level };
    run.screens = new Set();
    run.maxTemp = null;
    track(run, s);
  }

  return { sessionId: String(rows.session.id), type, startWall: Number(rows.session.start_wall), steps, excluded };
}
