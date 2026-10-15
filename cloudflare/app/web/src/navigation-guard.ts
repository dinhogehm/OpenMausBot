import { useEffect, useRef } from "react";

export type NavigationGuard = { dirty?: boolean; busy?: boolean };
/** Registrations belong to mounted forms; nothing is persisted between users. */
export class NavigationGuards {
  private entries = new Map<symbol, () => NavigationGuard>();
  register(read: () => NavigationGuard) {
    const key = Symbol(); this.entries.set(key, read);
    return () => { this.entries.delete(key); };
  }
  state(): "busy" | "dirty" | "clear" {
    const states = [...this.entries.values()].map((read) => read());
    return states.some((state) => state.busy) ? "busy" : states.some((state) => state.dirty) ? "dirty" : "clear";
  }
}
export const navigationGuards = new NavigationGuards();
export function useNavigationGuard(guard: NavigationGuard) {
  const current = useRef(guard); current.current = guard;
  useEffect(() => navigationGuards.register(() => current.current), []);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (current.current.dirty || current.current.busy) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);
}
export type NavigationPrompt = { state: "busy" | "dirty"; finish: (leave: boolean) => void };
let presentPrompt: ((prompt: NavigationPrompt | null) => void) | undefined;
let pendingPrompt: NavigationPrompt | undefined;
export function listenForNavigationPrompt(present: (prompt: NavigationPrompt | null) => void) {
  presentPrompt = present;
  return () => { pendingPrompt?.finish(false); if (presentPrompt === present) presentPrompt = undefined; };
}
export function canLeavePage(): Promise<boolean> {
  const state = navigationGuards.state();
  if (state === "clear") return Promise.resolve(true);
  return requestNavigationPrompt(state);
}
/** For a local form being closed while other sections remain mounted. */
export function confirmUnsavedChanges(): Promise<boolean> { return requestNavigationPrompt("dirty"); }
function requestNavigationPrompt(state: "dirty" | "busy"): Promise<boolean> {
  // A repeated click must not schedule a second navigation behind the same dialog.
  if (!presentPrompt || pendingPrompt) return Promise.resolve(false);
  return new Promise((resolve) => {
    const prompt: NavigationPrompt = { state, finish: (leave) => {
      if (pendingPrompt !== prompt) return;
      pendingPrompt = undefined;
      presentPrompt?.(null);
      resolve(leave && state === "dirty" && navigationGuards.state() !== "busy");
    } };
    pendingPrompt = prompt;
    presentPrompt?.(prompt);
  });
}
