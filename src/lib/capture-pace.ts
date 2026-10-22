import { useEffect, useRef } from "react";

/** How long a screen preview waits between captures. The 1 s check only asks this; the capture itself is paced:
 * a busy bot every 4 s while the window has focus, 15 s while it does not; an idle one every 30 s / 2 min. A retry
 * (contention) keeps its own short delay. A hidden page never polls (the panels stop their timer). */
export function previewCaptureMs({ busy, focused, retryDelay }: { busy: boolean; focused: boolean; retryDelay: number | null }): number {
  if (retryDelay !== null) return retryDelay;
  if (busy) return focused ? 4_000 : 15_000;
  return focused ? 30_000 : 120_000;
}

/** Whether this window has focus, as a ref (read inside a timer without restarting it). */
export function useWindowFocusedRef() {
  const focused = useRef(typeof document === "undefined" ? true : document.hasFocus?.() ?? true);
  useEffect(() => {
    const on = () => { focused.current = true; };
    const off = () => { focused.current = false; };
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}
