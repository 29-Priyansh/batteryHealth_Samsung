import { useEffect, useRef } from 'preact/hooks';

// Android back button: the most recently opened layer (sheet, detail page…) closes first.
type Handler = () => void;
const stack: { current: Handler }[] = [];

/** While mounted, the back button calls [handler] (if nothing opened later is on top). */
export function useBackHandler(handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const entry = { get current() { return ref.current; } };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}

/** Runs the top handler; false when nothing is open. */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.current();
  return true;
}
