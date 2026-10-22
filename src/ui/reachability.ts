// One-handed "reach" mode: when a screen is already scrolled to the top, pulling down
// keeps going and opens empty space above the content (up to half the screen), so the
// top elements come within thumb reach. The heading grows and moves to the centre of
// that space; header buttons ("followers") ride down with the content so they stay reachable.
//
// Smoothness: only GPU transforms are written, at most once per animation frame, and every
// layout measurement is taken while closed. The snap after release is a JS ease-out that a
// new touch can catch mid-flight without jumping.

const SNAP_MS = 360;
/** Heading size when fully open, relative to its collapsed size (One UI-style large title). */
const TITLE_SCALE = 1.6;

export interface ReachOptions {
  /** Element (or window) whose touches drive the gesture. */
  root: HTMLElement | Window;
  /** Current scroll offset of the screen; the gesture only starts at 0. */
  scrollTop: () => number;
  header: () => HTMLElement | null;
  title: () => HTMLElement | null;
  content: () => HTMLElement | null;
  /** Header elements that move down with the content (e.g. a back button). */
  followers?: () => HTMLElement[];
  /** Touches starting inside these elements are ignored. */
  ignore?: string;
}

export interface ReachController {
  /** Re-measures after the heading text or layout changes. */
  refresh(): void;
  /** Closes the space; false when it was already closed. */
  close(): boolean;
  destroy(): void;
}

// Most recently installed last, so the back button closes the screen in front first.
const controllers: ReachController[] = [];

/** Back button: closes the reach space of the front-most screen; false if none was open. */
export function closeReach(): boolean {
  for (let i = controllers.length - 1; i >= 0; i--) if (controllers[i]!.close()) return true;
  return false;
}

interface Geometry {
  max: number; // largest pull: content starts at 50% of the screen
  dx: number; // horizontal distance from the heading centre to the header centre
  dy: number; // vertical distance from the heading centre to its fully-open position
}

export function installReach(o: ReachOptions): ReachController {
  let pull = 0;
  let geo: Geometry | null = null;
  let frame = 0;
  let anim = 0;
  let lastY: number | null = null;
  let lastDy = 0;
  let tracking = false;

  /** Layout reads happen only here (while closed), never inside the per-frame write. */
  const measure = () => {
    const header = o.header();
    const title = o.title();
    if (!header || !title) return;
    title.style.transform = '';
    const h = header.getBoundingClientRect();
    const t = title.getBoundingClientRect();
    const max = Math.max(0, window.innerHeight / 2 - h.bottom);
    geo = {
      max,
      dx: h.left + h.width / 2 - (t.left + t.width / 2),
      // Fully open, the heading centre sits midway between the screen top and the content.
      dy: (h.bottom + max) / 2 - (t.top + t.height / 2),
    };
  };

  const write = () => {
    frame = 0;
    const title = o.title();
    const content = o.content();
    if (!geo || !title || !content) return;
    const open = pull > 0;
    // Position and size share one progress value, so the heading moves in a straight line
    // (no arch) and never rises while it grows; transform-origin is its centre.
    const p = geo.max > 0 ? Math.min(1, pull / geo.max) : 0;
    title.style.transform = open
      ? `translate3d(${p * geo.dx}px,${p * geo.dy}px,0) scale(${1 + (TITLE_SCALE - 1) * p})`
      : '';
    const shift = open ? `translate3d(0,${pull}px,0)` : '';
    content.style.transform = shift;
    content.style.willChange = open ? 'transform' : '';
    for (const f of o.followers?.() ?? []) f.style.transform = shift;
    o.header()?.classList.toggle('reach-open', open);
  };

  const set = (v: number) => {
    pull = v;
    if (!frame) frame = requestAnimationFrame(write);
  };

  const stopAnim = () => {
    if (anim) cancelAnimationFrame(anim);
    anim = 0;
  };

  const animateTo = (target: number) => {
    stopAnim();
    const from = pull;
    if (from === target) return;
    const start = performance.now();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / SNAP_MS);
      set(from + (target - from) * (1 - Math.pow(1 - t, 4)));
      anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    if (o.ignore && (e.target as Element).closest(o.ignore)) return;
    stopAnim(); // catch a snap mid-flight where it is
    if (pull === 0) measure();
    lastY = e.touches[0]!.clientY;
    lastDy = 0;
    tracking = true;
  };

  const onMove = (e: TouchEvent) => {
    if (!tracking || lastY == null || !geo) return;
    const y = e.touches[0]!.clientY;
    const dy = y - lastY;
    lastY = y;
    if (dy !== 0) lastDy = dy;
    // Pull down at the top, or push back up while open; otherwise it's a normal scroll.
    if (o.scrollTop() > 0 || (pull === 0 && dy <= 0)) return;
    e.preventDefault();
    // Gentle resistance near the end so the stop doesn't feel abrupt.
    const resistance = dy > 0 ? 1 - 0.55 * (pull / geo.max) : 1;
    set(Math.min(geo.max, Math.max(0, pull + dy * resistance)));
  };

  const onEnd = () => {
    if (!tracking) return;
    tracking = false;
    lastY = null;
    if (pull === 0 || !geo) return;
    // Snap open or closed, following the direction of the last movement.
    const open = lastDy > 0 ? pull > geo.max * 0.15 : lastDy < 0 ? pull > geo.max * 0.85 : pull > geo.max / 2;
    animateTo(open ? geo.max : 0);
  };

  // Tapping the heading while open closes the space again.
  const onClick = (e: Event) => {
    if (pull > 0 && (e.target as Element).closest('h1, h2')) animateTo(0);
  };

  const refresh = () => {
    measure();
    if (geo && pull > geo.max) pull = geo.max;
    set(pull);
  };

  const r = o.root as HTMLElement; // Window has the same listener API
  r.addEventListener('touchstart', onStart as EventListener, { passive: true });
  r.addEventListener('touchmove', onMove as EventListener, { passive: false });
  r.addEventListener('touchend', onEnd);
  r.addEventListener('touchcancel', onEnd);
  r.addEventListener('click', onClick);
  window.addEventListener('resize', refresh);
  measure();

  const controller: ReachController = {
    refresh,
    close() {
      if (pull === 0) return false;
      animateTo(0);
      return true;
    },
    destroy() {
      stopAnim();
      if (frame) cancelAnimationFrame(frame);
      r.removeEventListener('touchstart', onStart as EventListener);
      r.removeEventListener('touchmove', onMove as EventListener);
      r.removeEventListener('touchend', onEnd);
      r.removeEventListener('touchcancel', onEnd);
      r.removeEventListener('click', onClick);
      window.removeEventListener('resize', refresh);
      const i = controllers.indexOf(controller);
      if (i >= 0) controllers.splice(i, 1);
    },
  };
  controllers.push(controller);
  return controller;
}
