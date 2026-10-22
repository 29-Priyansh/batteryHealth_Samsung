import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './components';

export interface NavItem<K extends string> {
  key: K;
  label: string;
  icon: string;
}

const DRAG_THRESHOLD_PX = 6;
/** How far ahead (ms) the release velocity projects the highlight, like a light flick. */
const MOMENTUM_MS = 160;
/** Dragging this fraction of a tab towards a neighbour is enough to commit to it. */
const COMMIT_FRACTION = 0.3;
/** Release speed (px/ms) that commits to the neighbour even for a tiny drag. */
const FLICK_SPEED = 0.35;

/**
 * Floating tab bar. The rounded highlight slides to a tapped tab and can be dragged. On release
 * it carries a little momentum, so a short drag or flick towards a tab is enough to land on it.
 */
export function BottomNav<K extends string>(props: { items: NavItem<K>[]; active: K; onChange: (k: K) => void }) {
  const { items, active, onChange } = props;
  const navRef = useRef<HTMLElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [tabWidth, setTabWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null); // tab under the highlight while dragging
  const drag = useRef<{
    pointerId: number; startX: number; startIndex: number; grab: number; moved: boolean;
    x: number; v: number; lastT: number; lastClientX: number; frame: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const index = Math.max(0, items.findIndex((i) => i.key === active));
  const lit = hovered ?? index;

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => setTabWidth((nav.clientWidth - padding(nav) * 2) / items.length);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [items.length]);

  /** Moves the highlight straight in the DOM, once per frame, without re-rendering. */
  const place = (x: number) => {
    const d = drag.current;
    if (!d) return;
    d.x = x;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      const cur = drag.current;
      if (!cur) return;
      cur.frame = 0;
      if (highlightRef.current) highlightRef.current.style.transform = `translate3d(${cur.x}px,0,0)`;
      const h = Math.round(cur.x / tabWidth);
      setHovered((prev) => (prev === h ? prev : h));
    });
  };

  const localX = (nav: HTMLElement, clientX: number) => clientX - nav.getBoundingClientRect().left - padding(nav);

  const onPointerDown = (e: PointerEvent) => {
    const nav = navRef.current;
    if (!nav || tabWidth === 0) return;
    const px = localX(nav, e.clientX);
    // Only a press on the highlight starts a drag; anywhere else is a normal tap.
    if (px < index * tabWidth || px > (index + 1) * tabWidth) return;
    drag.current = {
      pointerId: e.pointerId, startX: e.clientX, startIndex: index, grab: px - index * tabWidth, moved: false,
      x: index * tabWidth, v: 0, lastT: e.timeStamp, lastClientX: e.clientX, frame: 0,
    };
    nav.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const nav = navRef.current;
    if (!d || !nav || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      highlightRef.current?.classList.add('dragging');
    }
    // Smoothed velocity (px/ms) for the release momentum.
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.v = 0.7 * ((e.clientX - d.lastClientX) / dt) + 0.3 * d.v;
    d.lastT = e.timeStamp;
    d.lastClientX = e.clientX;
    const maxX = tabWidth * (items.length - 1);
    const raw = localX(nav, e.clientX) - d.grab;
    // Soft rubber band past the first and last tab instead of a hard stop.
    const x = raw < 0 ? raw * 0.25 : raw > maxX ? maxX + (raw - maxX) * 0.25 : raw;
    place(x);
  };

  const endDrag = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    drag.current = null;
    if (!d.moved) return; // plain tap on the active tab
    // Swallow the click the browser may fire for this release, but never a later real tap.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);

    const target = momentumTarget(d.x, d.v, d.startIndex, tabWidth, items.length);
    const el = highlightRef.current;
    if (el) {
      el.classList.remove('dragging');
      // Duration scales with the remaining distance so short settles stay snappy.
      const remaining = Math.abs(target * tabWidth - d.x) / tabWidth;
      el.style.transitionDuration = `${Math.round(220 + 200 * Math.min(1, remaining))}ms`;
      el.style.transform = `translate3d(${target * tabWidth}px,0,0)`;
    }
    setHovered(null);
    if (items[target]!.key !== active) onChange(items[target]!.key);
  };

  return (
    <nav ref={navRef} class="bottomnav" aria-label="Main"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div ref={highlightRef} class="nav-highlight"
        style={{ width: `${tabWidth}px`, transform: `translate3d(${index * tabWidth}px,0,0)`, opacity: tabWidth ? 1 : 0 }}
        onTransitionEnd={(e) => { (e.currentTarget as HTMLElement).style.transitionDuration = ''; }} />
      {items.map((item, i) => (
        <button class={i === lit ? 'on' : ''} aria-current={item.key === active ? 'page' : undefined}
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            onChange(item.key);
          }}>
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function padding(nav: HTMLElement) {
  return parseFloat(getComputedStyle(nav).paddingLeft) || 0;
}

/**
 * Where the highlight lands after a drag: the release position projected forward by its velocity,
 * and at least one tab in the drag direction once the user has clearly committed to moving.
 */
export function momentumTarget(x: number, v: number, startIndex: number, tabWidth: number, count: number): number {
  if (tabWidth <= 0) return startIndex;
  const projected = x + v * MOMENTUM_MS;
  let target = Math.round(projected / tabWidth);
  const travelled = x / tabWidth - startIndex;
  if (target === startIndex) {
    if (travelled > COMMIT_FRACTION || v > FLICK_SPEED) target = startIndex + 1;
    else if (travelled < -COMMIT_FRACTION || v < -FLICK_SPEED) target = startIndex - 1;
  }
  return Math.min(count - 1, Math.max(0, target));
}
