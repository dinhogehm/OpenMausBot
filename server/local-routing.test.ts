import { describe, expect, it } from "vitest";
import { shouldMountLocalComputer, turnRunsUnattended } from "./local-routing.ts";

describe("local computer routing", () => {
  it("never lets Linux Auto fall back to the user's desktop", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit local selection and an approval-capable provider on Linux", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });

  it("preserves the established macOS Auto fallback", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
  });

  it("does not hand the desktop to a turn nobody started", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: true,
      }),
    ).toBe(false);
    // the same bot, the same Mac, a person at the keyboard: Auto still mounts
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: false,
      }),
    ).toBe(true);
  });

  it("keeps an explicit local choice: unattended narrows the fallback, not the decision", () => {
    // the person mounted this bot on their Mac on purpose; the approval rules
    // still card every host request, so the mount grants nothing on its own
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: true,
      }),
    ).toBe(true);
  });

  it("never mounts the local desktop for explicit cloud/off or on an unsupported host", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });
});

describe("turnRunsUnattended — the dispatch record outranks the bot mark", () => {
  /** The live sequence: a workflow node dispatched, timed out and interrupted,
   * then re-dispatched by the engine two minutes later. Between the two, the
   * per-bot mark is whatever happened to it — a person's queued message
   * cleared it, or the idle TTL aged it out. */
  it("a workflow re-dispatch after a timeout never mounts the desktop, whatever the bot mark says", () => {
    const workflowTurn = { automationSource: "workflow", unattended: true };
    const mount = (botMarked: boolean) =>
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: turnRunsUnattended(workflowTurn, botMarked),
      });
    // attempt 1: the mark is fresh
    expect(mount(true)).toBe(false);
    // attempt 3: the mark was cleared under the run — still no desktop
    expect(mount(false)).toBe(false);
  });

  it("judges any automated source as unattended even when the opts forgot to say so", () => {
    expect(turnRunsUnattended({ automationSource: "workflow" }, false)).toBe(true);
    expect(turnRunsUnattended({ automationSource: "webhook" }, false)).toBe(true);
    expect(turnRunsUnattended({ automationSource: "schedule" }, false)).toBe(true);
    // an inherited hop (a delegated turn from an unattended bot) carries the flag alone
    expect(turnRunsUnattended({ unattended: true }, false)).toBe(true);
  });

  it("keeps a person's own turn attended, and lets a stale bot mark only add caution", () => {
    expect(turnRunsUnattended({}, false)).toBe(false);
    expect(turnRunsUnattended({ unattended: false, automationSource: undefined }, false)).toBe(false);
    // the mark fails closed: a person's turn on a bot still marked asks a human, as before
    expect(turnRunsUnattended({}, true)).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
        unattended: turnRunsUnattended({}, false),
      }),
    ).toBe(true);
  });
});
