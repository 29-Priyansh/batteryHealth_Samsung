// Per-session summary for the history detail view: durations, average rate and the
// configuration change log. Pure module over raw rows from the recorder (docs/PLAN.md §5).
// The average here is a plain "points ÷ active hours" figure for display; the
// step-based estimator (§6–§8) remains the source for comparisons.

export type RawRow = Record<string, string | number | null>;

export interface SessionSummary {
  type: 'charging' | 'draining';
  startLevel: number | null;
  endLevel: number | null;
  /** Wall-clock time from start to end (or to now while running). */
  totalMs: number;
  /** Time actually charging (charging test) or discharging (draining test), not paused, no gaps. */
  activeMs: number;
  pausedMs: number;
  /** Time spent in the opposite state (unplugged during charging, charging during draining). */
  interruptedMs: number;
  /** Time without observations because the app was stopped or the phone restarted. */
  gapMs: number;
  /** |end − start| percentage points per active hour; null when too short to mean anything. */
  averageRate: number | null;
  finished: boolean;
}

const CHARGING = 2;
const DISCHARGING = 3;

/** Direction of a sample: +1 charging, -1 discharging, 0 neither (plugged but held, full, unknown). */
function direction(s: RawRow): number {
  if (s.status === CHARGING) return 1;
  if (s.status === DISCHARGING || s.plugged === 0) return -1;
  return 0;
}

export function summarize(
  session: RawRow, samples: RawRow[], events: RawRow[], now = Date.now(),
  type: 'charging' | 'draining' = session.type as 'charging' | 'draining',
): SessionSummary {
  const wanted = type === 'charging' ? 1 : -1;
  const ordered = [...samples].sort((a, b) => Number(a.id) - Number(b.id));
  const gapStarts = new Set(
    events.filter((e) => e.type === 'gap_detected').map((e) => Number(e.elapsed_ms)),
  );

  let activeMs = 0;
  let pausedMs = 0;
  let interruptedMs = 0;
  let gapMs = 0;
  let paused = false;

  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (a.reason === 'pause') paused = true;
    if (a.reason === 'resume') paused = false;
    const sameBoot = a.boot_count === b.boot_count;
    const dt = sameBoot ? Number(b.elapsed_ms) - Number(a.elapsed_ms) : Number(b.wall_ms) - Number(a.wall_ms);
    if (dt <= 0) continue;
    // A restart (reboot, or a gap recorded when the app came back) means nothing was observed in between.
    if (!sameBoot || (b.reason === 'recovery' && gapStarts.has(Number(b.elapsed_ms)))) {
      gapMs += dt;
    } else if (paused) {
      pausedMs += dt;
    } else if (direction(a) === wanted) {
      activeMs += dt;
    } else {
      interruptedMs += dt;
    }
  }

  const startLevel = toNum(session.start_level) ?? toNum(ordered[0]?.level);
  const endLevel = toNum(session.end_level) ?? toNum(ordered[ordered.length - 1]?.level);
  const startWall = Number(session.start_wall);
  const endWall = toNum(session.end_wall) ?? now;
  const points = startLevel != null && endLevel != null ? Math.abs(endLevel - startLevel) : 0;
  const hours = activeMs / 3_600_000;

  return {
    type,
    startLevel,
    endLevel,
    totalMs: Math.max(0, endWall - startWall),
    activeMs,
    pausedMs,
    interruptedMs,
    gapMs,
    averageRate: points >= 1 && hours >= 0.25 ? points / hours : null,
    finished: session.end_wall != null,
  };
}

export interface ChangeEntry {
  wall: number;
  param: string;
  from: string | null;
  to: string | null;
  /** 'auto' when read from the phone, 'you' when logged by hand. */
  source: 'auto' | 'you';
  /** Uncertainty of the change time in minutes (manual changes), 0 when exact. */
  windowMin: number;
}

export function changeLog(changes: RawRow[]): ChangeEntry[] {
  return [...changes]
    .sort((a, b) => Number(a.event_wall) - Number(b.event_wall))
    .map((c) => ({
      wall: Number(c.event_wall),
      param: String(c.param_key),
      from: c.prev_value == null ? null : String(c.prev_value),
      to: c.new_value == null ? null : String(c.new_value),
      source: c.detection_source === 'user_tap' ? 'you' : 'auto',
      windowMin: Math.round((Number(c.window_end_elapsed) - Number(c.window_start_elapsed)) / 60_000),
    }));
}

/** Parameter values in force when the session started. */
export function startingValues(configStates: RawRow[], paramValues: RawRow[]): { key: string; value: string | null; src: string }[] {
  const first = [...configStates].sort((a, b) => Number(a.id) - Number(b.id))[0];
  if (!first) return [];
  return paramValues
    .filter((p) => p.config_state_id === first.id)
    .map((p) => ({ key: String(p.param_key), value: p.value == null ? null : String(p.value), src: String(p.src) }));
}

function toNum(v: unknown): number | null {
  return v == null || v === '' ? null : Number(v);
}
