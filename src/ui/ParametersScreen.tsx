import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  analyzeSelection, DEFAULT_ASSUMPTIONS, DEFAULT_SELECTION, PARAMS, type CostAssumptions, type TestType,
} from '../engine/params';
import { loadSetting, saveSetting } from './settingsStore';

const TYPES: TestType[] = ['charging', 'draining'];

export function ParametersScreen() {
  const [type, setType] = useState<TestType>('draining');
  const [selection, setSelection] = useState<Record<TestType, string[]>>({
    charging: [...DEFAULT_SELECTION], draining: [...DEFAULT_SELECTION],
  });
  const [assumptions, setAssumptions] = useState<Record<TestType, CostAssumptions>>(DEFAULT_ASSUMPTIONS);
  const [chargers, setChargers] = useState<string[]>([]);
  const [saved, setSaved] = useState<Record<TestType, string[]> | null>(null);

  useEffect(() => {
    (async () => {
      const s = {
        charging: await loadSetting('selection.charging', [...DEFAULT_SELECTION]),
        draining: await loadSetting('selection.draining', [...DEFAULT_SELECTION]),
      };
      setSelection(s);
      setSaved(s);
      const c = await loadSetting<string[]>('chargers', []);
      setChargers(c);
      setAssumptions((a) => ({ ...a, charging: { ...a.charging, chargerCount: c.length } }));
    })();
  }, []);

  const current = selection[type];
  const cost = useMemo(() => analyzeSelection(current, type, assumptions[type]), [current, type, assumptions]);
  const dirty = saved !== null && JSON.stringify(saved[type]) !== JSON.stringify(current);
  const candidates = PARAMS.filter((p) => p.appliesTo.includes(type));

  const toggle = (key: string) =>
    setSelection((s) => ({
      ...s, [type]: s[type].includes(key) ? s[type].filter((k) => k !== key) : [...s[type], key],
    }));

  const setAssumption = (field: keyof CostAssumptions, value: number) =>
    setAssumptions((a) => ({ ...a, [type]: { ...a[type], [field]: value } }));

  const save = async () => {
    await saveSetting(`selection.${type}`, current);
    setSaved((s) => (s ? { ...s, [type]: current } : s));
  };

  const addCharger = () => {
    const name = prompt('Charger + cable label (e.g. "Samsung 45W + 1m cable")')?.trim();
    if (!name || chargers.includes(name)) return;
    const next = [...chargers, name];
    setChargers(next);
    setAssumption('chargerCount', next.length);
    void saveSetting('chargers', next);
  };

  return (
    <section>
      <div class="tabs" role="tablist">
        {TYPES.map((t) => (
          <button role="tab" aria-selected={t === type} class={t === type ? 'tab on' : 'tab'} onClick={() => setType(t)}>
            {t === 'charging' ? 'Charging tests' : 'Draining tests'}
          </button>
        ))}
      </div>

      <p class="muted">Choose which settings define a configuration for {type} tests. Results are only compared between sessions with identical values for these.</p>

      <ul class="params">
        {candidates.map((p) => (
          <li>
            <label>
              <input type="checkbox" checked={current.includes(p.key)} onChange={() => toggle(p.key)} />
              <span class="pname">{p.label}</span>
              <span class={`badge ${p.detection}`}>{p.detection === 'auto' ? 'automatic' : 'manual'}</span>
              <span class="levels">{p.key === 'charger' ? `${chargers.length || 'no'} saved` : p.levels.join(' / ')}</span>
            </label>
            <div class="note">{p.note}</div>
            {p.key === 'charger' && (
              <div class="chargers">
                {chargers.map((c) => <span class="chip">{c}</span>)}
                <button class="small" onClick={addCharger}>Add charger</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div class="card cost">
        <h3>Cost of this selection</h3>
        <div class="stats">
          <Stat label="Configurations" value={cost.configurations} />
          <Stat label="Sessions needed" value={cost.sessionsNeeded} />
          <Stat label="Test hours" value={Math.round(cost.testHours)} />
          <Stat label="Calendar days" value={cost.calendarDays} />
          <Stat label="Manual confirmations" value={cost.manualCount} />
        </div>
        <p class={`rec ${cost.configurations > 64 ? 'serious' : cost.configurations > 16 ? 'caution' : 'ok'}`}>{cost.recommendation}</p>
        <ul class="downsides">
          {cost.downsides.map((d) => <li class={d.severity}><b>{d.severity}</b> {d.text}</li>)}
        </ul>
        <details>
          <summary>Assumptions</summary>
          <NumField label="Repeats per configuration" value={assumptions[type].repeats} min={1} step={1} onInput={(v) => setAssumption('repeats', v)} />
          <NumField label="Hours per session" value={assumptions[type].hoursPerSession} min={0.25} step={0.25} onInput={(v) => setAssumption('hoursPerSession', v)} />
          <NumField label="Sessions per day" value={assumptions[type].sessionsPerDay} min={0.1} step={0.5} onInput={(v) => setAssumption('sessionsPerDay', v)} />
        </details>
      </div>

      <div class="actions">
        <button class="primary" disabled={!dirty} onClick={save}>{dirty ? 'Save selection' : 'Saved'}</button>
        <button onClick={() => setSelection((s) => ({ ...s, [type]: [...DEFAULT_SELECTION] }))}>Reset to default</button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div class="stat"><div class="v">{value.toLocaleString()}</div><div class="l">{label}</div></div>;
}

function NumField(props: { label: string; value: number; min: number; step: number; onInput: (v: number) => void }) {
  return (
    <label class="num">
      {props.label}
      <input type="number" value={props.value} min={props.min} step={props.step}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v) && v >= props.min) props.onInput(v);
        }} />
    </label>
  );
}
