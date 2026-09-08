// The bot settings dialog and the computer panel are siblings in one children
// list. Keying both by bot.id alone handed React two children with the same
// key: reconciliation matched the survivor to the wrong element, so closing
// settings while the computer panel was open left the dialog mounted and the
// X, Escape and the backdrop all looked dead (React also logs "Encountered
// two children with the same key"). Each overlay keys by its own slot now.
//
// This repo's vitest environment is node, so the reconciliation itself cannot
// be exercised here; what is pinned is the invariant that produced it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");

describe("App overlay keys", () => {
  it("never keys a per-bot overlay by the bot alone", () => {
    expect(source).not.toMatch(/key=\{bot\.id\}/);
  });

  it("gives each overlay slot its own key namespace", () => {
    const keys = [...source.matchAll(/key=\{`([a-z-]+):\$\{bot\.id\}`\}/g)].map((m) => m[1]);
    expect(keys).toContain("settings");
    expect(keys).toContain("computer");
    expect(new Set(keys).size).toBe(keys.length);
  });
});
