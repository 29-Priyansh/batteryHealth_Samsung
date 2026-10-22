// Aggregation and comparison (docs/PLAN.md §7–§9). The unit of replication is the session:
// each session contributes one rate per configuration (and per battery band); configurations
// are summarised by the median across sessions, never by pooling steps as if independent.

import { BAND_SIZE, type SessionSteps, type Step } from './steps';
import type { TestType } from './params';

/** Minimum complete steps for a session's rate in a configuration to count. */
export const MIN_STEPS = 3;
/** Minimum steps for a session's rate inside one 10% band to count. */
export const MIN_BAND_STEPS = 2;

export interface SessionRate {
  sessionId: string;
  startWall: number;
  config: string;
  steps: number;
  hours: number;
  /** Percentage points per hour (always positive). */
  rate: number;
  bands: Record<number, { steps: number; hours: number }>;
  screenOnShare: number | null;
  maxTempC: number | null;
}

export interface ConfigStats {
  config: string;
  sessions: SessionRate[];
  /** Sessions too short to use, kept so the UI can say so. */
  shortSessions: number;
  totalSteps: number;
  median: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Median rate per 10% band, across sessions with enough steps in that band. */
  bandMedian: Record<number, number>;
}

export function sessionRates(s: SessionSteps): SessionRate[] {
  const byConfig = new Map<string, Step[]>();
  for (const st of s.steps) byConfig.set(st.config, [...(byConfig.get(st.config) ?? []), st]);
  return [...byConfig.entries()].map(([config, steps]) => {
    const hours = steps.reduce((h, st) => h + st.durationMs, 0) / 3.6e6;
    const bands: SessionRate['bands'] = {};
    for (const st of steps) {
      const b = (bands[st.band] ??= { steps: 0, hours: 0 });
      b.steps++;
      b.hours += st.durationMs / 3.6e6;
    }
    const withScreen = steps.filter((st) => st.screen === 'on' || st.screen === 'off');
    const temps = steps.map((st) => st.maxTempC).filter((t): t is number => t != null);
    return {
      sessionId: s.sessionId,
      startWall: s.startWall,
      config,
      steps: steps.length,
      hours,
      rate: hours > 0 ? steps.length / hours : 0,
      bands,
      screenOnShare: withScreen.length ? withScreen.filter((st) => st.screen === 'on').length / withScreen.length : null,
      maxTempC: temps.length ? Math.max(...temps) : null,
    };
  });
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

export function aggregate(all: SessionSteps[]): ConfigStats[] {
  const byConfig = new Map<string, SessionRate[]>();
  for (const s of all) for (const r of sessionRates(s)) byConfig.set(r.config, [...(byConfig.get(r.config) ?? []), r]);
  return [...byConfig.entries()].map(([config, rates]) => {
    const usable = rates.filter((r) => r.steps >= MIN_STEPS);
    const vals = usable.map((r) => r.rate);
    const bandMedian: Record<number, number> = {};
    for (let b = 0; b < 10; b++) {
      const m = median(usable.flatMap((r) => {
        const x = r.bands[b];
        return x && x.steps >= MIN_BAND_STEPS && x.hours > 0 ? [x.steps / x.hours] : [];
      }));
      if (m != null) bandMedian[b] = m;
    }
    return {
      config,
      sessions: usable,
      shortSessions: rates.length - usable.length,
      totalSteps: rates.reduce((n, r) => n + r.steps, 0),
      median: median(vals),
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      bandMedian,
    };
  }).sort((a, b) => b.sessions.length - a.sessions.length || a.config.localeCompare(b.config));
}

export interface Prediction {
  hours: number;
  /** True when some bands had no data and the overall median was used for them. */
  extrapolated: boolean;
}

/** Predicted time from one level to another, using each band's own rate (§7.2). */
export function predict(stats: ConfigStats, from: number, to: number): Prediction | null {
  if (stats.median == null || from === to) return null;
  const dir = to > from ? 1 : -1;
  let hours = 0;
  let extrapolated = false;
  for (let l = from; l !== to; l += dir) {
    const band = Math.min(9, Math.floor(Math.min(l, l + dir) / BAND_SIZE));
    const rate = stats.bandMedian[band];
    if (rate == null) extrapolated = true;
    hours += 1 / (rate ?? stats.median);
  }
  return { hours, extrapolated };
}

export type Verdict = 'insufficient' | 'no_difference' | 'leaning' | 'clear';

export interface Comparison {
  verdict: Verdict;
  /** Relative difference of A vs B in rate over matched bands (+0.2 = A's rate is 20% higher). */
  diff: number | null;
  /** Which configuration is better: draining → lower rate, charging → higher rate. */
  better: 'a' | 'b' | null;
  matchedBands: number[];
  reasons: string[];
}

/** Compares two configurations over the battery bands both have data for (§9). */
export function compare(type: TestType, a: ConfigStats, b: ConfigStats): Comparison {
  const reasons: string[] = [];
  if (a.sessions.length < 2 || b.sessions.length < 2) {
    reasons.push(`Needs at least 2 usable tests for each (have ${a.sessions.length} and ${b.sessions.length}).`);
    return { verdict: 'insufficient', diff: null, better: null, matchedBands: [], reasons };
  }
  const matchedBands = Object.keys(a.bandMedian).map(Number).filter((k) => b.bandMedian[k] != null);
  if (!matchedBands.length) {
    reasons.push('The two were never measured over the same battery range (e.g. both between 60% and 70%).');
    return { verdict: 'insufficient', diff: null, better: null, matchedBands, reasons };
  }
  const ratio = matchedBands.reduce((acc, k) => acc + a.bandMedian[k]! / b.bandMedian[k]!, 0) / matchedBands.length;
  const diff = ratio - 1;
  const aBetter = type === 'draining' ? diff < 0 : diff > 0;

  const tempA = median(a.sessions.map((s) => s.maxTempC).filter((t): t is number => t != null));
  const tempB = median(b.sessions.map((s) => s.maxTempC).filter((t): t is number => t != null));
  if (tempA != null && tempB != null && Math.abs(tempA - tempB) > 4) {
    reasons.push(`Battery temperature differed (${tempA.toFixed(0)} vs ${tempB.toFixed(0)} °C), which affects the rate.`);
  }
  const scrA = median(a.sessions.map((s) => s.screenOnShare).filter((t): t is number => t != null));
  const scrB = median(b.sessions.map((s) => s.screenOnShare).filter((t): t is number => t != null));
  if (scrA != null && scrB != null && Math.abs(scrA - scrB) > 0.25) {
    reasons.push(`Screen-on time differed (${Math.round(scrA * 100)}% vs ${Math.round(scrB * 100)}% of the time).`);
  }

  if (Math.abs(diff) < 0.08) {
    reasons.unshift('Difference under 8%, within normal test-to-test variation.');
    return { verdict: 'no_difference', diff, better: null, matchedBands, reasons };
  }
  const separated = a.max! < b.min! || b.max! < a.min!;
  const verdict: Verdict = a.sessions.length >= 3 && b.sessions.length >= 3 && separated && reasons.length === 0 ? 'clear' : 'leaning';
  if (verdict === 'leaning') {
    if (!separated) reasons.unshift('Individual tests overlap, so more tests are needed to be sure.');
    else if (a.sessions.length < 3 || b.sessions.length < 3) reasons.unshift('Run at least 3 tests of each to confirm.');
  }
  return { verdict, diff, better: aBetter ? 'a' : 'b', matchedBands, reasons };
}
