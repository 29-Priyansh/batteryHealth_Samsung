import { describe, expect, it } from 'vitest';
import { aggregate, compare, predict, sessionRates } from './compare';
import { bandOf, extractSteps, type SessionRows } from './steps';
import type { RawRow } from './summary';

const MIN = 60_000;
const SEL = ['power_saving'];

/** Builds a draining/charging session from (minute, level) points with optional per-point overrides. */
function session(
  type: 'charging' | 'draining',
  points: [number, number, Partial<RawRow>?][],
  opts: { id?: string; states?: Record<number, string>; changes?: RawRow[] } = {},
): SessionRows {
  const id = opts.id ?? 's1';
  const status = type === 'charging' ? 2 : 3;
  const plugged = type === 'charging' ? 1 : 0;
  const states = opts.states ?? { 1: 'off' };
  return {
    session: { id, type, start_wall: 0 },
    samples: points.map(([min, level, extra], i) => ({
      id: i + 1, elapsed_ms: min * MIN, wall_ms: min * MIN, boot_count: 1, level, status, plugged,
      reason: 'level', config_state_id: 1, screen_on: 0, temp_dc: 300, ...extra,
    })),
    events: [],
    configStates: Object.keys(states).map((k) => ({ id: Number(k) })),
    paramValues: Object.entries(states).map(([k, v]) => ({ config_state_id: Number(k), param_key: 'power_saving', value: v, src: 'verified' })),
    configChanges: opts.changes ?? [],
  };
}

describe('extractSteps', () => {
  it('worked example §8.4 segment A: 79 → 73 in 52 min (first level partial)', () => {
    const pts: [number, number][] = [[0, 80], [6, 79], [15, 78], [24, 77], [33, 76], [42, 75], [51, 74], [58, 73]];
    const s = extractSteps(session('draining', pts), SEL);
    expect(s.steps).toHaveLength(6);
    const [r] = sessionRates(s);
    expect(r!.rate).toBeCloseTo(6 / (52 / 60), 6);
  });

  it('a configuration change starts a new run, so the straddling step is dropped', () => {
    const pts: [number, number, Partial<RawRow>?][] = [
      [0, 80], [10, 79], [20, 78], [30, 77],
      [35, 77, { config_state_id: 2, reason: 'config' }], [40, 76, { config_state_id: 2 }],
      [50, 75, { config_state_id: 2 }], [60, 74, { config_state_id: 2 }],
    ];
    const s = extractSteps(session('draining', pts, { states: { 1: 'off', 2: 'on' } }), SEL);
    const off = s.steps.filter((x) => x.config === 'power_saving=off');
    const on = s.steps.filter((x) => x.config === 'power_saving=on');
    expect(off).toHaveLength(2); // 79→78, 78→77
    expect(on).toHaveLength(2); // 76→75, 75→74 (77→76 straddles the change)
  });

  it('samples inside a manual change window are excluded', () => {
    const pts: [number, number, Partial<RawRow>?][] = [[0, 80], [10, 79], [20, 78], [25, 77], [40, 76], [50, 75], [60, 74]];
    const change = { window_start_elapsed: 22 * MIN, window_end_elapsed: 27 * MIN, boot_count: 1 };
    const s = extractSteps(session('draining', pts, { changes: [change] }), SEL);
    expect(s.excluded['uncertain change time']).toBe(1);
    expect(s.steps.map((x) => x.fromLevel)).toEqual([79, 75]);
  });

  it('charging interruptions, pauses and jumps break runs', () => {
    const pts: [number, number, Partial<RawRow>?][] = [
      [0, 60], [10, 59], [20, 58],
      [25, 58, { status: 2, plugged: 1 }], // charging interruption
      [40, 61], [50, 60], [60, 59],
      [62, 59, { reason: 'pause' }], [70, 58], [75, 58, { reason: 'resume' }],
      [80, 57], [90, 56], [95, 53], [105, 52],
    ];
    const s = extractSteps(session('draining', pts), SEL);
    expect(s.steps.map((x) => [x.fromLevel, x.toLevel])).toEqual([[59, 58], [60, 59], [53, 52]]);
    expect(s.excluded['battery level jumped']).toBe(1);
    expect(s.excluded.charging).toBe(1);
  });

  it('unknown settings are excluded from configuration results', () => {
    const rows = session('draining', [[0, 80], [10, 79], [20, 78]]);
    rows.paramValues = [];
    expect(extractSteps(rows, SEL).steps).toHaveLength(0);
  });

  it('bands by the lower level of the step', () => {
    expect(bandOf(80, 79)).toBe(7);
    expect(bandOf(100, 99)).toBe(9);
    expect(bandOf(9, 10)).toBe(0);
  });
});

function drainingSession(id: string, ps: 'on' | 'off', minPerStep: number, from = 80, steps = 10): SessionRows {
  const pts: [number, number][] = [[0, from]];
  for (let i = 1; i <= steps + 1; i++) pts.push([2 + (i - 1) * minPerStep, from - i]);
  return session('draining', pts, { id, states: { 1: ps } });
}

describe('aggregate / predict / compare', () => {
  it('summarises by session, with band medians', () => {
    const stats = aggregate([
      extractSteps(drainingSession('a', 'off', 6), SEL),
      extractSteps(drainingSession('b', 'off', 10), SEL),
      extractSteps(drainingSession('c', 'off', 8), SEL),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.sessions).toHaveLength(3);
    expect(stats[0]!.median).toBeCloseTo(7.5, 6); // 60/8
    expect(stats[0]!.min).toBeCloseTo(6, 6);
    expect(stats[0]!.max).toBeCloseTo(10, 6);
  });

  it('predicts using band rates and flags extrapolation', () => {
    const [st] = aggregate([extractSteps(drainingSession('a', 'off', 6), SEL), extractSteps(drainingSession('b', 'off', 6), SEL)]);
    const inRange = predict(st!, 78, 72)!;
    expect(inRange.hours).toBeCloseTo(0.6, 6); // 6 points at 10 %/h
    expect(inRange.extrapolated).toBe(false);
    expect(predict(st!, 78, 20)!.extrapolated).toBe(true);
  });

  it('reports a clear winner only with 3+ separated tests each', () => {
    const off = [6, 6.5, 7].map((m, i) => extractSteps(drainingSession(`off${i}`, 'off', m), SEL));
    const on = [10, 11, 12].map((m, i) => extractSteps(drainingSession(`on${i}`, 'on', m), SEL));
    const stats = aggregate([...off, ...on]);
    const a = stats.find((s) => s.config === 'power_saving=on')!;
    const b = stats.find((s) => s.config === 'power_saving=off')!;
    const c = compare('draining', a, b);
    expect(c.verdict).toBe('clear');
    expect(c.better).toBe('a'); // power saving on drains slower
    expect(c.diff!).toBeLessThan(-0.3);
  });

  it('is inconclusive with too few tests, and calls tiny differences no difference', () => {
    const one = aggregate([extractSteps(drainingSession('x', 'on', 6), SEL), extractSteps(drainingSession('y', 'off', 6), SEL)]);
    expect(compare('draining', one[0]!, one[1]!).verdict).toBe('insufficient');
    const same = aggregate([
      ...[6, 6.2].map((m, i) => extractSteps(drainingSession(`p${i}`, 'on', m), SEL)),
      ...[6.1, 6.3].map((m, i) => extractSteps(drainingSession(`q${i}`, 'off', m), SEL)),
    ]);
    expect(compare('draining', same[0]!, same[1]!).verdict).toBe('no_difference');
  });
});
