import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canLeavePage, listenForNavigationPrompt, navigationGuards, NavigationGuards, type NavigationPrompt } from "../src/navigation-guard.ts";

test("a pending operation blocks leaving even when another form is only dirty", () => {
  const guards = new NavigationGuards(); const draft = { dirty: true }; const pending = { busy: true };
  const removeDraft = guards.register(() => draft); const removePending = guards.register(() => pending);
  assert.equal(guards.state(), "busy"); pending.busy = false;
  assert.equal(guards.state(), "dirty"); removeDraft(); assert.equal(guards.state(), "clear"); removePending();
});
test("unmounting the company removes its guards without leaking them to the next account", () => {
  const guards = new NavigationGuards(); const unmount = guards.register(() => ({ dirty: true, busy: true }));
  assert.equal(guards.state(), "busy"); unmount(); unmount(); assert.equal(guards.state(), "clear");
});

test("one confirmation cannot accept multiple queued navigations", async () => {
  let current: NavigationPrompt | null = null;
  const unmount = listenForNavigationPrompt((prompt) => { current = prompt; });
  const remove = navigationGuards.register(() => ({ dirty: true }));
  try {
    const first = canLeavePage();
    assert.equal(await canLeavePage(), false);
    assert.equal(current?.state, "dirty");
    current?.finish(true);
    assert.equal(await first, true);
    assert.equal(current, null);
  } finally { remove(); unmount(); }
});

test("navigation stays blocked if an operation starts while a discard dialog is open", async () => {
  let current: NavigationPrompt | null = null; const state = { dirty: true, busy: false };
  const unmount = listenForNavigationPrompt((prompt) => { current = prompt; });
  const remove = navigationGuards.register(() => state);
  try {
    const decision = canLeavePage(); state.busy = true; current?.finish(true);
    assert.equal(await decision, false);
    const pending = canLeavePage(); assert.equal(current?.state, "busy"); unmount();
    assert.equal(await pending, false);
  } finally { remove(); unmount(); }
});
