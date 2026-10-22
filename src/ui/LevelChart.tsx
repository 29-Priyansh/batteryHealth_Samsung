import type { RawRow } from '../engine/summary';
import { getParam } from '../engine/params';
import { fmtTime } from './time';

const W = 340;
const H = 170;
const PAD = { l: 30, r: 8, t: 10, b: 22 };

/**
 * Battery level over time for one test: the line is the recorded level, grey bands mark time
 * that didn't count (paused, interrupted, not observed) and dashed lines mark setting changes.
 * Plain SVG: drawn once, no animation, no chart library.
 */
export function LevelChart({ session, samples, changes }: { session: RawRow; samples: RawRow[]; changes: RawRow[] }) {
  const pts = [...samples].sort((a, b) => Number(a.id) - Number(b.id));
  if (pts.length < 2) return <p class="muted small">Not enough observations for a graph yet.</p>;

  const t0 = Number(session.start_wall);
  const t1 = Math.max(Number(pts[pts.length - 1]!.wall_ms), t0 + 60_000);
  const levels = pts.map((p) => Number(p.level));
  const lo = Math.max(0, Math.floor((Math.min(...levels) - 3) / 5) * 5);
  const hi = Math.min(100, Math.ceil((Math.max(...levels) + 3) / 5) * 5);
  const x = (ms: number) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (lv: number) => PAD.t + ((hi - lv) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);

  const wanted = session.type === 'charging' ? 2 : 3;
  // Spans that didn't count: paused, wrong direction, or a restart between samples.
  const off: [number, number][] = [];
  let paused = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a.reason === 'pause') paused = true;
    if (a.reason === 'resume') paused = false;
    const restarted = a.boot_count !== b.boot_count || b.reason === 'recovery';
    const counted = !paused && !restarted && (a.status === wanted || (wanted === 3 && a.plugged === 0));
    if (!counted) off.push([Number(a.wall_ms), Number(b.wall_ms)]);
  }

  // Step-shaped line: the level holds until the next observation.
  let d = `M${x(Number(pts[0]!.wall_ms)).toFixed(1)},${y(levels[0]!).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const px = x(Number(pts[i]!.wall_ms)).toFixed(1);
    d += `H${px}V${y(levels[i]!).toFixed(1)}`;
  }

  const yTicks = [lo, Math.round((lo + hi) / 2), hi];
  const xTicks = [t0, (t0 + t1) / 2, t1];

  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Battery level over time">
        {yTicks.map((v) => (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} class="grid" />
            <text x={PAD.l - 4} y={y(v) + 3} text-anchor="end" class="axis">{v}%</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text x={x(t)} y={H - 6} text-anchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} class="axis">{fmtTime(t)}</text>
        ))}
        {off.map(([a, b]) => (
          <rect x={x(a)} y={PAD.t} width={Math.max(1, x(b) - x(a))} height={H - PAD.t - PAD.b} class="off" />
        ))}
        {changes.map((c) => (
          <line x1={x(Number(c.event_wall))} x2={x(Number(c.event_wall))} y1={PAD.t} y2={H - PAD.b} class="change">
            <title>{`${label(String(c.param_key))}: ${c.prev_value ?? '?'} → ${c.new_value ?? '?'}`}</title>
          </line>
        ))}
        <path d={d} class={`level ${session.type}`} />
      </svg>
      <figcaption class="muted small">
        <span class="key off" /> not counted (paused, interrupted, not observed)
        {changes.length > 0 && <><span class="key change" /> setting changed</>}
      </figcaption>
    </figure>
  );
}

function label(key: string) {
  try { return getParam(key).label; } catch { return key; }
}
