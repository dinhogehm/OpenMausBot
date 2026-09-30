import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_SERVICE, SessionToken } from "./session-token.ts";

const FAKE = "fake-token-for-test";

describe("the GitHub token sessions run with", () => {
  it("reads the Keychain entry without a shell, for the owner's account, and hands it to the platform's sessions only", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const token = new SessionToken({ user: "osvaldo", read: (file, args) => { calls.push({ file, args }); return `${FAKE}\n`; } });
    expect(token.envFor("/Users/osvaldo/Projetos/nuria-platform")).toEqual({ env: { GH_TOKEN: FAKE, GITHUB_TOKEN: FAKE }, missing: false });
    expect(calls).toEqual([{ file: "/usr/bin/security", args: ["find-generic-password", "-s", SESSION_TOKEN_SERVICE, "-a", "osvaldo", "-w"] }]);
    expect(token.envFor("/Users/osvaldo/Projetos/OpenMausBot")).toEqual({ env: {}, missing: false });
    token.envFor("/Users/osvaldo/Projetos/nuria-platform");
    expect(calls).toHaveLength(1); // cached
  });

  it("says it is missing when the Keychain has no entry, and reads again later", () => {
    let now = 0;
    let stored: string | null = null;
    const token = new SessionToken({ user: "o", now: () => now, read: () => { if (stored === null) throw new Error("not found"); return stored; } });
    expect(token.envFor("/x/nuria-platform")).toEqual({ env: {}, missing: true });
    stored = FAKE;
    now += 6 * 60_000;
    expect(token.envFor("/x/nuria-platform").env.GH_TOKEN).toBe(FAKE);
  });
});
