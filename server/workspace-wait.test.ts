import { describe, expect, it } from "vitest";

import { folderFreeText, folderStillBusyText, folderWaitEndedText, folderWaitingText } from "./workspace-wait.ts";

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
