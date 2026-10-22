import { describe, expect, it } from 'vitest';
import { changeLog, startingValues, summarize, type RawRow } from './summary';

const MIN = 60_000;
let id = 0;
const sample = (min: number, level: number, status: number, plugged: number, reason = 'level', boot = 39): RawRow =>
  ({ id: ++id, elapsed_ms: min * MIN, wall_ms: 1_000_000 + min * MIN, boot_count: boot, level, status, plugged, reason });

describe('summarize', () => {
  it('draining 80% → 35% over 3 h with a 20 min charging interruption and a pause', () => {
    id = 0;
    const session = { type: 'draining', start_level: 80, end_level: 35, start_wall: 1_000_000, end_wall: 1_000_000 + 200 * MIN };
    const samples = [
      sample(0, 80, 3, 0, 'start'),
      sample(60, 70, 3, 0),
      sample(80, 68, 2, 1, 'plugged'), // charging 80–100 min: interruption
      sample(100, 71, 3, 0, 'plugged'),
      sample(130, 66, 3, 0, 'pause'), // paused 130–150 min
      sample(150, 66, 3, 0, 'resume'),
      sample(200, 35, 3, 0, 'stop'),
    ];
    const s = summarize(session, samples, []);
    expect(s.totalMs).toBe(200 * MIN);
    expect(s.interruptedMs).toBe(20 * MIN);
    expect(s.pausedMs).toBe(20 * MIN);
    expect(s.activeMs).toBe(160 * MIN);
    expect(s.averageRate).toBeCloseTo(45 / (160 / 60), 5);
    expect(s.finished).toBe(true);
  });

  it('charging counts unplugged and held time as not active', () => {
    id = 0;
    const session = { type: 'charging', start_level: 30, end_level: 80, start_wall: 1_000_000, end_wall: 1_000_000 + 100 * MIN };
    const samples = [
      sample(0, 30, 2, 1, 'start'),
      sample(20, 50, 3, 0, 'plugged'), // unplugged 20–65
      sample(65, 46, 2, 1, 'plugged'),
      sample(90, 78, 4, 1, 'status'), // held 90–100
      sample(100, 80, 2, 1, 'stop'),
    ];
    const s = summarize(session, samples, []);
    expect(s.activeMs).toBe((20 + 25) * MIN);
    expect(s.interruptedMs).toBe((45 + 10) * MIN);
  });

  it('a reboot between samples is a gap measured by wall clock', () => {
    id = 0;
    const session = { type: 'draining', start_level: 60, end_level: 50, start_wall: 1_000_000, end_wall: null };
    const samples = [sample(0, 60, 3, 0, 'start'), sample(30, 57, 3, 0), { ...sample(40, 56, 3, 0, 'recovery', 40), elapsed_ms: 5_000 }];
    const s = summarize(session, samples, [], 1_000_000 + 45 * MIN);
    expect(s.gapMs).toBe(10 * MIN);
    expect(s.activeMs).toBe(30 * MIN);
    expect(s.finished).toBe(false);
    expect(s.totalMs).toBe(45 * MIN);
  });

  it('reports no average for very short tests', () => {
    id = 0;
    const session = { type: 'draining', start_level: 60, end_level: 59, start_wall: 0, end_wall: 5 * MIN };
    expect(summarize(session, [sample(0, 60, 3, 0), sample(5, 59, 3, 0)], []).averageRate).toBeNull();
  });
});

describe('changeLog', () => {
  it('orders changes and labels their source and uncertainty', () => {
    const log = changeLog([
      { event_wall: 300, param_key: 'perf_profile', prev_value: 'standard', new_value: 'light', detection_source: 'user_tap', window_start_elapsed: 0, window_end_elapsed: 4 * MIN },
      { event_wall: 100, param_key: 'power_saving', prev_value: 'off', new_value: 'on', detection_source: 'broadcast', window_start_elapsed: 5, window_end_elapsed: 5 },
    ]);
    expect(log.map((c) => c.param)).toEqual(['power_saving', 'perf_profile']);
    expect(log[0]).toMatchObject({ source: 'auto', windowMin: 0, from: 'off', to: 'on' });
    expect(log[1]).toMatchObject({ source: 'you', windowMin: 4 });
  });
});

describe('startingValues', () => {
  it('returns the first configuration state only', () => {
    const v = startingValues(
      [{ id: 2 }, { id: 1 }],
      [
        { config_state_id: 1, param_key: 'wifi', value: 'on', src: 'verified' },
        { config_state_id: 2, param_key: 'wifi', value: 'off', src: 'verified' },
      ],
    );
    expect(v).toEqual([{ key: 'wifi', value: 'on', src: 'verified' }]);
  });
});
