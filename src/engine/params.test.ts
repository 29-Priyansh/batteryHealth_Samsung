import { describe, expect, it } from 'vitest';
import {
  analyzeSelection, applicable, configKey, DEFAULT_ASSUMPTIONS, DEFAULT_SELECTION, displayCode, enumerateConfigs, PARAMS,
} from './params';

describe('parameter catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(PARAMS.map((p) => p.key)).size).toBe(PARAMS.length);
  });

  it('default selection gives 16 configurations for both test types', () => {
    expect(enumerateConfigs(DEFAULT_SELECTION, 'charging')).toHaveLength(16);
    expect(enumerateConfigs(DEFAULT_SELECTION, 'draining')).toHaveLength(16);
  });

  it('filters parameters by applicability', () => {
    const sel = ['fast_charging', 'aod', 'wifi'];
    expect(applicable(sel, 'charging').map((p) => p.key)).toEqual(['wifi', 'fast_charging']);
    expect(applicable(sel, 'draining').map((p) => p.key)).toEqual(['wifi', 'aod']);
  });

  it('expands chargers from the user list', () => {
    expect(enumerateConfigs(['charger', 'fast_charging'], 'charging', ['25W', '45W', 'PC'])).toHaveLength(6);
  });
});

describe('configKey', () => {
  const values = {
    network_mode: { value: '5g', src: 'user_confirmed' as const },
    mobile_data: { value: 'on', src: 'verified' as const },
    power_saving: { value: 'off', src: 'verified' as const },
    perf_profile: { value: 'standard', src: 'user_confirmed' as const },
    wifi: { value: 'off', src: 'verified' as const },
  };

  it('is canonical and independent of selection order', () => {
    const a = configKey(values, DEFAULT_SELECTION, 'draining');
    const b = configKey(values, [...DEFAULT_SELECTION].reverse(), 'draining');
    expect(a).toBe('mobile_data=on;network_mode=5g;perf_profile=standard;power_saving=off');
    expect(b).toBe(a);
  });

  it('ignores unselected parameters', () => {
    expect(configKey(values, ['wifi'], 'draining')).toBe('wifi=off');
  });

  it('returns null when a selected parameter is unknown', () => {
    expect(configKey({ ...values, perf_profile: { value: null, src: 'unknown' } }, DEFAULT_SELECTION, 'draining')).toBeNull();
    expect(configKey({ mobile_data: values.mobile_data }, DEFAULT_SELECTION, 'draining')).toBeNull();
  });

  it('maps to a stable display code', () => {
    const all = enumerateConfigs(DEFAULT_SELECTION, 'draining');
    const key = configKey(values, DEFAULT_SELECTION, 'draining')!;
    expect(displayCode(key, all)).toMatch(/^C\d\d$/);
    expect(displayCode('nope', all)).toBe('C??');
  });
});

describe('analyzeSelection', () => {
  it('default selection is realistic', () => {
    const c = analyzeSelection(DEFAULT_SELECTION, 'draining');
    expect(c.configurations).toBe(16);
    expect(c.sessionsNeeded).toBe(48);
    expect(c.manualCount).toBe(2);
    expect(c.downsides.find((d) => d.id === 'thinning')).toBeUndefined();
    expect(c.recommendation).toMatch(/^Realistic/);
  });

  it('warns seriously about large selections', () => {
    const all = PARAMS.map((p) => p.key);
    const c = analyzeSelection(all, 'draining');
    expect(c.configurations).toBe(2 ** 9);
    expect(c.downsides.find((d) => d.id === 'thinning')?.severity).toBe('serious');
    expect(c.downsides.find((d) => d.id === 'time')?.severity).toBe('serious');
    expect(c.recommendation).toMatch(/^Impractical/);
  });

  it('counts battery protection levels and chargers for charging', () => {
    const c = analyzeSelection(['battery_protection', 'charger'], 'charging', { ...DEFAULT_ASSUMPTIONS.charging, chargerCount: 2 });
    expect(c.configurations).toBe(8);
  });

  it('reports parameters ignored for the test type', () => {
    const c = analyzeSelection(['fast_charging', 'power_saving'], 'draining');
    expect(c.ignored.map((p) => p.key)).toEqual(['fast_charging']);
    expect(c.configurations).toBe(2);
  });

  it('flags an empty selection', () => {
    expect(analyzeSelection([], 'charging').downsides.map((d) => d.id)).toContain('no_params');
  });
});
