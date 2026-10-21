// Parameter catalogue, configuration identity and selection-cost analysis.
// Pure module: no DOM, no Capacitor. See docs/PLAN.md, Revision 2.

export type TestType = 'charging' | 'draining';
export type Detection = 'auto' | 'manual';
export type ValueSource = 'verified' | 'user_confirmed' | 'inferred' | 'unknown';

export interface ParamDef {
  key: string;
  label: string;
  /** Allowed values. Empty for user-defined lists (e.g. chargers). */
  levels: readonly string[];
  appliesTo: readonly TestType[];
  detection: Detection;
  /** Why this matters for battery behaviour; shown in the selection UI. */
  note: string;
}

export const PARAMS: readonly ParamDef[] = [
  {
    key: 'network_mode', label: 'Network mode', levels: ['5g', '4g'], appliesTo: ['charging', 'draining'],
    detection: 'manual', note: 'Preference cannot be read by apps; the observed radio (LTE/NR) is recorded as evidence.',
  },
  {
    key: 'mobile_data', label: 'Mobile data', levels: ['on', 'off'], appliesTo: ['charging', 'draining'],
    detection: 'auto', note: 'Read via TelephonyManager (needs phone-state permission).',
  },
  {
    key: 'power_saving', label: 'Power saving', levels: ['on', 'off'], appliesTo: ['charging', 'draining'],
    detection: 'auto', note: 'Read via PowerManager; changes are detected instantly.',
  },
  {
    key: 'perf_profile', label: 'Performance profile', levels: ['standard', 'light'], appliesTo: ['charging', 'draining'],
    detection: 'manual', note: 'Samsung-only setting with no public API.',
  },
  {
    key: 'wifi', label: 'Wi-Fi', levels: ['on', 'off'], appliesTo: ['charging', 'draining'],
    detection: 'auto', note: 'Strong confounder for mobile-data comparisons.',
  },
  {
    key: 'location', label: 'Location', levels: ['on', 'off'], appliesTo: ['draining'],
    detection: 'auto', note: 'Background location use can dominate idle drain.',
  },
  {
    key: 'dark_mode', label: 'Dark mode', levels: ['on', 'off'], appliesTo: ['draining'],
    detection: 'auto', note: 'Affects OLED screen power during screen-on time only.',
  },
  {
    key: 'refresh_rate', label: 'Motion smoothness', levels: ['adaptive', 'standard'], appliesTo: ['draining'],
    detection: 'manual', note: 'Adaptive (up to 120 Hz) vs Standard (60 Hz); screen-on effect only.',
  },
  {
    key: 'aod', label: 'Always On Display', levels: ['on', 'off'], appliesTo: ['draining'],
    detection: 'manual', note: 'Affects screen-off drain.',
  },
  {
    key: 'fast_charging', label: 'Fast charging', levels: ['on', 'off'], appliesTo: ['charging'],
    detection: 'manual', note: 'Directly limits charging power.',
  },
  {
    key: 'battery_protection', label: 'Battery protection', levels: ['off', 'basic', 'adaptive', 'maximum'],
    appliesTo: ['charging'], detection: 'manual', note: 'May stop charging before the target (held state).',
  },
  {
    key: 'charger', label: 'Charger', levels: [], appliesTo: ['charging'],
    detection: 'manual', note: 'Your saved charger/cable labels; wattage cannot be read.',
  },
];

export const DEFAULT_SELECTION: readonly string[] = ['network_mode', 'mobile_data', 'power_saving', 'perf_profile'];

const byKey = new Map(PARAMS.map((p) => [p.key, p]));

export function getParam(key: string): ParamDef {
  const p = byKey.get(key);
  if (!p) throw new Error(`Unknown parameter: ${key}`);
  return p;
}

/** Parameters from a selection that are meaningful for the given test type, in catalogue order. */
export function applicable(selection: readonly string[], type: TestType): ParamDef[] {
  const sel = new Set(selection);
  return PARAMS.filter((p) => sel.has(p.key) && p.appliesTo.includes(type));
}

export function levelCount(p: ParamDef, chargerCount: number): number {
  return p.key === 'charger' ? Math.max(1, chargerCount) : p.levels.length;
}

export interface ParamValue {
  value: string | null;
  src: ValueSource;
}

/**
 * Canonical configuration key for the selected parameters, or null if any selected
 * parameter is unknown (such spans are excluded from configuration views).
 */
export function configKey(
  values: Readonly<Record<string, ParamValue | undefined>>,
  selection: readonly string[],
  type: TestType,
): string | null {
  const parts: string[] = [];
  for (const p of applicable(selection, type).sort((a, b) => a.key.localeCompare(b.key))) {
    const v = values[p.key];
    if (!v || v.value === null || v.src === 'unknown') return null;
    parts.push(`${p.key}=${v.value}`);
  }
  return parts.join(';');
}

/** All configuration keys for a selection, sorted; index+1 gives the display code (C01…). */
export function enumerateConfigs(
  selection: readonly string[],
  type: TestType,
  chargers: readonly string[] = [],
): string[] {
  const params = applicable(selection, type).sort((a, b) => a.key.localeCompare(b.key));
  let combos: string[][] = [[]];
  for (const p of params) {
    const levels = p.key === 'charger' ? (chargers.length ? chargers : ['unspecified']) : p.levels;
    combos = combos.flatMap((c) => levels.map((l) => [...c, `${p.key}=${l}`]));
  }
  return combos.map((c) => c.join(';')).sort();
}

export function displayCode(key: string, allKeys: readonly string[]): string {
  const i = allKeys.indexOf(key);
  return i < 0 ? 'C??' : `C${String(i + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- cost analysis

export interface CostAssumptions {
  repeats: number;
  hoursPerSession: number;
  sessionsPerDay: number;
  chargerCount: number;
}

export const DEFAULT_ASSUMPTIONS: Record<TestType, CostAssumptions> = {
  charging: { repeats: 3, hoursPerSession: 1.5, sessionsPerDay: 2, chargerCount: 1 },
  draining: { repeats: 3, hoursPerSession: 4, sessionsPerDay: 2, chargerCount: 1 },
};

export type Severity = 'info' | 'caution' | 'serious';

export interface Downside {
  id: string;
  severity: Severity;
  text: string;
}

export interface SelectionCost {
  type: TestType;
  params: ParamDef[];
  ignored: ParamDef[];
  configurations: number;
  sessionsNeeded: number;
  testHours: number;
  calendarDays: number;
  manualCount: number;
  autoCount: number;
  downsides: Downside[];
  recommendation: string;
}

export function analyzeSelection(
  selection: readonly string[],
  type: TestType,
  a: CostAssumptions = DEFAULT_ASSUMPTIONS[type],
): SelectionCost {
  const params = applicable(selection, type);
  const ignored = PARAMS.filter((p) => selection.includes(p.key) && !p.appliesTo.includes(type));
  const configurations = params.reduce((n, p) => n * levelCount(p, a.chargerCount), 1);
  const sessionsNeeded = configurations * a.repeats;
  const testHours = sessionsNeeded * a.hoursPerSession;
  const calendarDays = Math.ceil(sessionsNeeded / Math.max(0.1, a.sessionsPerDay));
  const manual = params.filter((p) => p.detection === 'manual');
  const auto = params.filter((p) => p.detection === 'auto');

  const downsides: Downside[] = [];
  const push = (id: string, severity: Severity, text: string) => downsides.push({ id, severity, text });

  if (params.length === 0) {
    push('no_params', 'caution', 'No parameters selected: every session counts as the same configuration, so nothing can be compared.');
  }
  if (configurations > 16) {
    push('thinning', configurations > 64 ? 'serious' : 'caution',
      `${configurations} configurations spread your data thin: each one needs ${a.repeats} sessions before any comparison is conclusive; until then most comparisons will show "inconclusive".`);
  }
  if (calendarDays > 14) {
    push('time', calendarDays > 60 ? 'serious' : 'caution',
      `About ${sessionsNeeded} sessions (~${Math.round(testHours)} h of testing) at ${a.sessionsPerDay}/day takes about ${formatDays(calendarDays)}. Battery ageing and OS updates during that time become confounders themselves.`);
  }
  if (manual.length > 0) {
    push('manual', manual.length > 3 ? 'serious' : manual.length > 1 ? 'caution' : 'info',
      `${manual.length} manual parameter${manual.length > 1 ? 's' : ''} (${manual.map((p) => p.label).join(', ')}): you must confirm ${manual.length > 1 ? 'them' : 'it'} at every test start and log every change. A forgotten change makes that span "unknown" and it is excluded.`);
  }
  if (params.length > 4) {
    push('boundaries', 'caution',
      'More parameters usually means more mid-test changes; each change discards about 1 percentage point at the boundary to keep attribution honest.');
  }
  if (ignored.length > 0) {
    push('ignored', 'info',
      `${ignored.map((p) => p.label).join(', ')} ${ignored.length > 1 ? 'do' : 'does'} not affect ${type} tests and will be ignored for them.`);
  }
  const unselectedAuto = PARAMS.filter((p) => p.detection === 'auto' && p.appliesTo.includes(type) && !selection.includes(p.key));
  if (unselectedAuto.length > 0) {
    push('confounders', 'info',
      `Not selected but still recorded automatically: ${unselectedAuto.map((p) => p.label).join(', ')}. They are shown as conditions and can be added to the selection later without losing history.`);
  }
  const unselectedManual = PARAMS.filter((p) => p.detection === 'manual' && p.appliesTo.includes(type) && !selection.includes(p.key));
  if (unselectedManual.length > 0) {
    push('not_recorded', 'info',
      `Not selected and not recorded: ${unselectedManual.map((p) => p.label).join(', ')}. Adding one later leaves earlier sessions "unknown" for it.`);
  }
  if (auto.length > 0) {
    push('overhead', 'info', 'Automatic parameters add no measurable battery overhead (event listeners only).');
  }

  const recommendation =
    configurations <= 16 ? 'Realistic: a full set of repeated tests fits in a few weeks.'
    : configurations <= 64 ? 'Ambitious: expect months for full coverage; consider testing only the configurations you care about.'
    : 'Impractical for full coverage: reduce parameters, or treat this as exploratory and compare only a few configurations.';

  return {
    type, params, ignored, configurations, sessionsNeeded, testHours, calendarDays,
    manualCount: manual.length, autoCount: auto.length, downsides, recommendation,
  };
}

function formatDays(d: number): string {
  if (d < 14) return `${d} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${Math.round(d / 30)} months`;
}
