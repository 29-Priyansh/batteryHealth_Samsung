// Always-on ("everyday") data (docs/PLAN.md R2.9). Kept apart from deliberate tests:
// - configurations use only automatically read settings (manual ones would go stale unnoticed);
// - each everyday session (one automatic test per charge/discharge cycle) is the unit of replication;
// - rates are split by screen state, because in everyday use screen-on time and activity
//   dominate drain; screen-off (idle) rates are the controlled part used for comparisons;
// - only recent days count, since ageing, updates and seasons shift the numbers.

import { aggregate, type ConfigStats } from './compare';
import { applicable, type TestType } from './params';
import { extractSteps, type SessionRows, type SessionSteps } from './steps';

export const EVERYDAY_WINDOW_DAYS = 30;

export type ScreenFilter = 'off' | 'on' | 'all';

export const isEveryday = (rows: { session: Record<string, unknown> }) => rows.session.mode === 'passive';

/** Selection for everyday data: the user's selection restricted to automatically read settings. */
export function everydaySelection(selection: readonly string[], type: TestType): string[] {
  return applicable(selection, type).filter((p) => p.detection === 'auto').map((p) => p.key);
}

/** Steps from everyday days within the window, for one direction. */
export function everydaySteps(all: SessionRows[], selection: readonly string[], type: TestType, now = Date.now()): SessionSteps[] {
  const since = now - EVERYDAY_WINDOW_DAYS * 86_400_000;
  const sel = everydaySelection(selection, type);
  return all
    .filter((r) => isEveryday(r) && Number(r.session.start_wall) >= since)
    .map((r) => extractSteps(r, sel, type));
}

/** Keeps only steps taken entirely with the screen off (or on); mixed steps are dropped. */
export function byScreen(steps: SessionSteps[], screen: ScreenFilter): SessionSteps[] {
  if (screen === 'all') return steps;
  return steps.map((s) => ({ ...s, steps: s.steps.filter((st) => st.screen === screen) }));
}

export interface EverydayStats {
  config: string;
  off: ConfigStats | null;
  on: ConfigStats | null;
  all: ConfigStats;
  days: number;
}

export function everydayStats(steps: SessionSteps[]): EverydayStats[] {
  const all = aggregate(steps);
  const off = new Map(aggregate(byScreen(steps, 'off')).map((s) => [s.config, s]));
  const on = new Map(aggregate(byScreen(steps, 'on')).map((s) => [s.config, s]));
  return all.map((a) => ({
    config: a.config,
    all: a,
    off: off.get(a.config) ?? null,
    on: on.get(a.config) ?? null,
    days: new Set([...a.sessions.map((s) => s.sessionId)]).size,
  }));
}

export interface Priors {
  draining: { keys: string[]; rates: Record<string, { rate: number; steps: number }> };
  charging: { keys: string[]; rates: Record<string, { rate: number; steps: number }> };
}

/**
 * History per configuration for the live estimate's starting point, keyed by automatically read
 * settings only (the recorder can rebuild that key itself). Uses tests and everyday days alike,
 * all screen states: it seeds a "typical for you" estimate, it is not a comparison.
 */
export function computePriors(all: SessionRows[], selection: Record<TestType, readonly string[]>, now = Date.now()): Priors {
  const build = (type: TestType) => {
    const keys = everydaySelection(selection[type], type);
    const since = now - EVERYDAY_WINDOW_DAYS * 86_400_000;
    const steps = all
      .filter((r) => Number(r.session.start_wall) >= since && (isEveryday(r) || r.session.type === type))
      .map((r) => extractSteps(r, keys, type));
    const rates: Priors['draining']['rates'] = {};
    for (const st of aggregate(steps)) if (st.median != null) rates[st.config] = { rate: st.median, steps: st.totalSteps };
    return { keys, rates };
  };
  return { draining: build('draining'), charging: build('charging') };
}
