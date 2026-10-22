import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useBackHandler } from './backStack';
import { useEffect, useState } from 'preact/hooks';

// ---------------------------------------------------------------- toast

type ToastListener = (msg: string) => void;
const toastListeners = new Set<ToastListener>();

export function toast(msg: string) {
  toastListeners.forEach((l) => l(msg));
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const l: ToastListener = (m) => {
      setMsg(m);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(null), 2600);
    };
    toastListeners.add(l);
    return () => { toastListeners.delete(l); clearTimeout(timer); };
  }, []);
  return msg ? <div class="toast" role="status">{msg}</div> : null;
}

// ---------------------------------------------------------------- bottom sheet

export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  useBackHandler(props.onClose);
  return createPortal(
    <div class="scrim" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-grip" />
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- chips

export function ChipGroup<T extends string | number>(props: {
  options: readonly T[];
  value: T | null | undefined;
  onChange: (v: T) => void;
  label?: (v: T) => string;
}) {
  return (
    <div class="chips" role="radiogroup">
      {props.options.map((o) => (
        <button type="button" role="radio" aria-checked={o === props.value}
          class={o === props.value ? 'chip on' : 'chip'} onClick={() => props.onChange(o)}>
          {props.label ? props.label(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>(props: { options: readonly T[]; value: T; onChange: (v: T) => void; label?: (v: T) => string }) {
  return (
    <div class="segmented" role="tablist">
      {props.options.map((o) => (
        <button type="button" role="tab" aria-selected={o === props.value}
          class={o === props.value ? 'on' : ''} onClick={() => props.onChange(o)}>
          {props.label ? props.label(o) : o}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- battery level picker

/** Preset chips plus a "Custom" chip that reveals a slider and an exact number field. */
export function LevelPicker(props: {
  presets: readonly number[];
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const [custom, setCustom] = useState(!props.presets.includes(props.value));
  useEffect(() => { if (!props.presets.includes(props.value)) setCustom(true); }, [props.value]);
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, Math.round(v)));
  return (
    <div class="level-picker">
      <div class="chips" role="radiogroup">
        {props.presets.map((p) => (
          <button type="button" role="radio" aria-checked={!custom && p === props.value}
            class={!custom && p === props.value ? 'chip on' : 'chip'}
            onClick={() => { setCustom(false); props.onChange(p); }}>{p}%</button>
        ))}
        <button type="button" role="radio" aria-checked={custom} class={custom ? 'chip on' : 'chip'}
          onClick={() => setCustom(true)}>{custom ? `Custom · ${props.value}%` : 'Custom'}</button>
      </div>
      {custom && (
        <div class="custom-level">
          <input type="range" min={props.min} max={props.max} step={1} value={props.value}
            aria-label="Battery percentage"
            onInput={(e) => props.onChange(clamp(Number((e.target as HTMLInputElement).value)))} />
          <div class="custom-number">
            <input type="number" inputMode="numeric" min={props.min} max={props.max} value={props.value}
              aria-label="Battery percentage"
              onChange={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) props.onChange(clamp(v));
              }} />
            <span>%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- battery gauge

export function Gauge({ level, charging }: { level: number; charging: boolean }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const tone = charging ? 'var(--charging-fill)' : level <= 20 ? 'var(--serious)' : level <= 40 ? 'var(--caution)' : 'var(--accent)';
  return (
    <svg class="gauge" viewBox="0 0 120 120" role="img" aria-label={`Battery ${level}%`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--track)" stroke-width="10" />
      <circle cx="60" cy="60" r={r} fill="none" stroke={tone} stroke-width="10" stroke-linecap="round"
        stroke-dasharray={`${(c * level) / 100} ${c}`} transform="rotate(-90 60 60)" />
      <text x="60" y="66" text-anchor="middle" class="gauge-text">{level}%</text>
    </svg>
  );
}

// ---------------------------------------------------------------- icons (inline, stroke = currentColor)

const paths: Record<string, string> = {
  test: 'M9 2h6M10 2v2M14 2v2M7 4h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 13h2l1.5-3 2 6 1.5-3h1',
  setup: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  diag: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  drain: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  back: 'M19 12H5M11 6l-6 6 6 6',
  results: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};

export function Icon({ name, size = 22 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

// ---------------------------------------------------------------- formatting

export function formatHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '–';
  const m = Math.max(0, Math.round(h * 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export { clockIn } from './time';
