// One answer to "is anybody at the keyboard?", pinned per source, and the
// live sequence it exists for: a workflow node re-dispatched after a timeout
// must never reach the desktop whatever the per-bot mark says by then.
import { describe, expect, it } from "vitest";

import { shouldMountLocalComputer } from "./local-routing.ts";
import { turnProvenanceFor, unattendedByEither, type TurnProvenance } from "./turn-provenance.ts";

describe("turnProvenanceFor", () => {
  it("marks a webhook and a workflow node unattended, and a person's turn attended", () => {
    expect(turnProvenanceFor({ automationSource: "webhook" }, undefined)).toEqual({ automationSource: "webhook", unattended: true });
    expect(turnProvenanceFor({ automationSource: "workflow", unattended: true }, undefined)).toEqual({
      automationSource: "workflow",
      unattended: true,
    });
    expect(turnProvenanceFor(undefined, undefined)).toEqual({ unattended: false });
    expect(turnProvenanceFor({}, undefined)).toEqual({ unattended: false });
  });

  it("keeps a routine attended, scheduled or Run now: its prompt is the person's own text", () => {
    // upstream restricted the unattended mark to webhooks on purpose — a
    // scheduled Chief of Staff routine in Auto must not card on its first `ls`
    expect(turnProvenanceFor({ automationSource: "schedule" }, undefined)).toEqual({ automationSource: "schedule", unattended: false });
    expect(turnProvenanceFor({ automationSource: "manual" }, undefined)).toEqual({ automationSource: "manual", unattended: false });
    // …unless the caller was itself unattended (a hop from a webhook-driven bot)
    expect(turnProvenanceFor({ automationSource: "manual", unattended: true }, undefined).unattended).toBe(true);
    expect(turnProvenanceFor({ unattended: true }, undefined)).toEqual({ unattended: true });
  });

  it("copies a workflow node's keys and omits the field when there are none", () => {
    const keys = ["shell:gh"];
    const record = turnProvenanceFor({ automationSource: "workflow", alwaysAllow: keys }, undefined);
    expect(record.alwaysAllow).toEqual(["shell:gh"]);
    expect(record.alwaysAllow).not.toBe(keys);
    expect(turnProvenanceFor({ automationSource: "workflow", alwaysAllow: [] }, undefined)).not.toHaveProperty("alwaysAllow");
  });

  it("lets a card continuation inherit the turn it resumes, and judge itself when there is nothing to inherit", () => {
    const workflow: TurnProvenance = { automationSource: "workflow", unattended: true, alwaysAllow: ["shell:gh"] };
    expect(turnProvenanceFor({ cardContinuation: true }, workflow)).toBe(workflow);
    // a person's turn is never re-labelled by a continuation on the same thread
    const person: TurnProvenance = { unattended: false };
    expect(turnProvenanceFor({ cardContinuation: true, unattended: true }, person)).toBe(person);
    // no record (the dispatch belonged to a process that died): its own opts decide
    expect(turnProvenanceFor({ cardContinuation: true, unattended: true }, undefined)).toEqual({ unattended: true });
    expect(turnProvenanceFor({ cardContinuation: true }, undefined)).toEqual({ unattended: false });
    // and a fresh dispatch never inherits, even with a record on the thread
    expect(turnProvenanceFor({}, workflow)).toEqual({ unattended: false });
  });
});

describe("the desktop and a turn nobody started", () => {
  /** Exactly what index.ts's Auto fallback reads: the thread record OR the bot mark. */
  const mount = (record: TurnProvenance | undefined, botMarked: boolean) =>
    shouldMountLocalComputer({
      requested: undefined,
      hostPlatform: "darwin",
      providerSupportsLocal: true,
      unattended: unattendedByEither(record, botMarked),
    });

  it("unattendedByEither is never narrower than the bot mark, and a thread with no record is judged by the mark", () => {
    expect(unattendedByEither({ unattended: true }, false)).toBe(true);
    expect(unattendedByEither({ unattended: false }, true)).toBe(true);
    expect(unattendedByEither({ unattended: false }, false)).toBe(false);
    expect(unattendedByEither(undefined, false)).toBe(false);
    expect(unattendedByEither(undefined, true)).toBe(true);
  });

  it("a workflow re-dispatch after a timeout never mounts the desktop, whatever the bot mark says", () => {
    // The live sequence: dispatched, timed out and interrupted, re-dispatched
    // by the engine two minutes later. Between the two the per-bot mark is
    // whatever happened to it — a person's queued message cleared it, or the
    // idle TTL aged it out.
    const attempt = turnProvenanceFor({ automationSource: "workflow", unattended: true }, undefined);
    expect(mount(attempt, true)).toBe(false); // attempt 1: the mark is fresh
    expect(mount(attempt, false)).toBe(false); // attempt 3: the mark is gone — still no desktop
  });

  it("keeps Auto for a person's turn and for a routine, and lets a stale mark only add caution", () => {
    expect(mount(turnProvenanceFor(undefined, undefined), false)).toBe(true);
    expect(mount(turnProvenanceFor({ automationSource: "manual" }, undefined), false)).toBe(true);
    expect(mount(turnProvenanceFor({ automationSource: "schedule" }, undefined), false)).toBe(true);
    // the mark fails closed: a person's turn on a bot still marked asks a human, as before
    expect(mount(turnProvenanceFor(undefined, undefined), true)).toBe(false);
    expect(mount(turnProvenanceFor({ automationSource: "webhook" }, undefined), false)).toBe(false);
  });
});
