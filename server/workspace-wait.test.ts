import { describe, expect, it } from "vitest";

import { folderFreeText, folderStillBusyText, folderWaitEndedText, folderWaitingText, folderWaitWouldDeadlock } from "./workspace-wait.ts";

describe("project folder wait wording", () => {
  it("reads as a queue position behind a named turn, never as an error", () => {
    expect(folderWaitingText({ name: "Produto", task: "Refinar o backlog" })).toBe(
      "Waiting for its turn in this project folder — Produto is running Refinar o backlog. Starts automatically when that finishes.",
    );
    // a holder with no thread title (a room, or a bot's untitled turn)
    expect(folderWaitingText({ name: "Engineering Room" })).toBe(
      "Waiting for its turn in this project folder — Engineering Room is working there. Starts automatically when that finishes.",
    );
    expect(folderWaitingText(undefined)).toBe("Waiting for its turn in this project folder. Starts automatically when it is free.");
    for (const text of [folderWaitingText({ name: "Ada", task: "Refill" }), folderWaitingText(null)]) {
      expect(text).not.toMatch(/error|failed|blocked/i);
    }
  });

  it("settles the same chip with what happened", () => {
    expect(folderFreeText()).toBe("Project folder free — continuing");
    expect(folderWaitEndedText()).toBe("Stopped waiting for the project folder");
  });

  it("names the holder and a way out when the wait gives up", () => {
    expect(folderStillBusyText({ name: "Produto", task: "Refinar o backlog" }, 30 * 60_000)).toBe(
      "Another thread is still working in this project folder after 30 minutes — Produto is still running Refinar o backlog. Stop that turn, or choose a separate folder.",
    );
    expect(folderStillBusyText({ name: "Ada" }, 30 * 60_000)).toBe(
      "Another thread is still working in this project folder after 30 minutes — Ada is still working there. Stop that turn, or choose a separate folder.",
    );
    expect(folderStillBusyText(undefined, 45_000)).toBe(
      "Another thread is still working in this project folder after 45 seconds. Stop that turn, or choose a separate folder.",
    );
  });
});

describe("refusing to queue when queueing cannot help", () => {
  it("catches a direct and an indirect wait back onto this turn", () => {
    // A is parked on B's reply, so B must not queue behind A's folder
    expect(folderWaitWouldDeadlock("A", "B", new Map([["A", "B"]]))).toBe(true);
    // A waits on B, B waits on C: C must not queue behind A either
    expect(folderWaitWouldDeadlock("A", "C", new Map([["A", "B"], ["B", "C"]]))).toBe(true);
  });

  it("lets an ordinary holder be queued behind", () => {
    expect(folderWaitWouldDeadlock("A", "B", new Map())).toBe(false);
    // A is waiting on someone else entirely
    expect(folderWaitWouldDeadlock("A", "B", new Map([["A", "Z"]]))).toBe(false);
  });

  it("terminates on a cycle that does not include this turn", () => {
    expect(folderWaitWouldDeadlock("A", "me", new Map([["A", "B"], ["B", "A"]]))).toBe(false);
  });
});
