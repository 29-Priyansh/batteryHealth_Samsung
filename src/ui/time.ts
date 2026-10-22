// Clock formatting that follows the phone's own 12/24-hour setting. The WebView's locale alone
// doesn't reflect that toggle, so the native side reports it once at startup.

let hour12: boolean | undefined;

export function setHour12(is24Hour: boolean) {
  hour12 = !is24Hour;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12 });
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12 });
}

/** Clock time [hours] from now. */
export function clockIn(hours: number): string {
  return fmtTime(Date.now() + hours * 3_600_000);
}

// ---------------------------------------------------------------- in-app "open" requests

/** Something the UI should open: from a notification tap or another screen. */
export type OpenRequest = { kind: 'log_change' } | { kind: 'session'; id: string };

const openListeners = new Set<(r: OpenRequest) => void>();
let pendingOpen: OpenRequest | null = null;

export function parseOpen(action: string | null | undefined): OpenRequest | null {
  if (!action) return null;
  if (action === 'log_change') return { kind: 'log_change' };
  if (action.startsWith('session:')) return { kind: 'session', id: action.slice('session:'.length) };
  return null;
}

export function requestOpen(r: OpenRequest) {
  if (openListeners.size === 0) pendingOpen = r;
  openListeners.forEach((l) => l(r));
}

/** Subscribes to open requests; also delivers one that arrived before anyone listened. */
export function onOpenRequest(l: (r: OpenRequest) => void): () => void {
  openListeners.add(l);
  if (pendingOpen) { const r = pendingOpen; pendingOpen = null; l(r); }
  return () => openListeners.delete(l);
}
