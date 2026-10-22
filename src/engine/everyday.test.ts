import { describe, expect, it } from 'vitest';
import { computePriors, everydaySelection, everydayStats, everydaySteps } from './everyday';
import type { SessionRows } from './steps';
import type { RawRow } from './summary';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 100 * DAY;

/** An everyday day: draining with alternating screen-off and screen-on stretches, then a charge. */
function day(id: string, startDay: number, opts: { wifi?: string; offMin?: number; onMin?: number } = {}): SessionRows {
  const off = opts.offMin ?? 30; // minutes per 1% with the screen off
  const on = opts.onMin ?? 6; // minutes per 1% with the screen on
  const samples: RawRow[] = [];
  let t = 0;
  let level = 90;
  let i = 0;
  const push = (status: number, plugged: number, screen: number, extra: Partial<RawRow> = {}) =>
    samples.push({ id: ++i, elapsed_ms: t * MIN, wall_ms: startDay * DAY + t * MIN, boot_count: 1, level, status, plugged,
      reason: 'level', config_state_id: 1, screen_on: screen, temp_dc: 300, ...extra });
  push(3, 0, 0);
  for (let k = 0; k < 5; k++) { t += off; level--; push(3, 0, 0); } // screen off: 5 steps
  push(3, 0, 1, { reason: 'screen_on' });
  for (let k = 0; k < 5; k++) { t += on; level--; push(3, 0, 1); } // screen on
  for (let k = 0; k < 6; k++) { t += 2; level++; push(2, 1, 1); } // charging 2 min per %
  return {
    session: { id, type: 'draining', mode: 'passive', start_wall: startDay * DAY },
    samples, events: [],
    configStates: [{ id: 1 }],
    paramValues: [
      { config_state_id: 1, param_key: 'wifi', value: opts.wifi ?? 'on', src: 'verified' },
      { config_state_id: 1, param_key: 'perf_profile', value: null, src: 'unknown' },
    ],
    configChanges: [],
  };
}

const SEL = ['wifi', 'perf_profile'];

describe('everyday', () => {
  it('drops manual settings from the everyday selection', () => {
    expect(everydaySelection(SEL, 'draining')).toEqual(['wifi']);
  });

  it('splits rates by screen state and counts days', () => {
    const steps = everydaySteps([day('d1', 98), day('d2', 99)], SEL, 'draining', NOW);
    const [st] = everydayStats(steps);
    expect(st!.config).toBe('wifi=on');
    expect(st!.days).toBe(2);
    expect(st!.off!.median).toBeCloseTo(2, 6); // 1% per 30 min
    expect(st!.on!.median).toBeCloseTo(10, 6); // 1% per 6 min
  });

  it('extracts the charging direction from the same days', () => {
    const steps = everydaySteps([day('d1', 98), day('d2', 99)], SEL, 'charging', NOW);
    expect(everydayStats(steps)[0]!.all.median).toBeCloseTo(30, 6); // 1% per 2 min
  });

  it('ignores days outside the 30-day window and deliberate tests', () => {
    const old = day('old', 60);
    const test = { ...day('t', 99), session: { id: 't', type: 'draining', mode: 'test', start_wall: 99 * DAY } };
    expect(everydaySteps([old, test, day('d', 99)], SEL, 'draining', NOW)).toHaveLength(1);
  });

  it('computes priors keyed by automatic settings for both directions', () => {
    const p = computePriors([day('d1', 98, { offMin: 30, onMin: 6 }), day('d2', 99, { wifi: 'off' })],
      { draining: SEL, charging: SEL }, NOW);
    expect(p.draining.keys).toEqual(['wifi']);
    expect(Object.keys(p.draining.rates).sort()).toEqual(['wifi=off', 'wifi=on']);
    expect(p.charging.rates['wifi=on']!.rate).toBeCloseTo(30, 6);
  });
});
