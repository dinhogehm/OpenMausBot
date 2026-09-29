import { describe, expect, it } from "vitest";
import { fingerprintOf, parseWatchCommand, runWatchCommand, splitWords, WATCH_OUTPUT_MAX, watchMatches } from "./wake-watch.ts";

describe("parseWatchCommand", () => {
  it.each([
    "gh pr view 9286 -R dinhogehm/nuria-platform --json state,statusCheckRollup",
    `gh pr view 9286 --json statusCheckRollup --jq '.statusCheckRollup[] | .conclusion'`,
    "gh run list -R o/r --limit 1 --json status,conclusion",
    "gh api repos/o/r/commits/main/status",
    "git ls-remote origin refs/heads/main",
    "git -C /tmp/repo log --oneline -1",
    "curl -sS -f https://app.nuria.run/health",
    "gog chat messages list spaces/AAQA4TXnzJ4 --json --no-input",
    "gog --account osvaldo@x.com chat spaces get spaces/AAQA4TXnzJ4 --json",
    "gog sheets get 163U0o9RWFKqikUNsJu6T3tG1rP_3Mn3STZ1W6uYMDPQ Atendimento!A1:I400 --json",
  ])("accepts the read %s", (command) => {
    expect(parseWatchCommand(command).ok).toBe(true);
  });

  it.each([
    ["gh pr merge 1", /limited to reads/],
    ["gh pr view 1 --web", /--web/],
    ["gh api -X POST repos/o/r/issues", /may only read/],
    ["gh api repos/o/r/issues -f title=x", /may only read/],
    ["git push origin main", /git is limited/],
    ["git -C /tmp commit -m x", /git is limited/],
    ["curl -X DELETE https://x.dev/a", /may only GET/],
    ["curl -d a=1 https://x.dev", /may only GET/],
    ["curl -o /etc/x https://x.dev", /may only GET/],
    ["curl file:///etc/passwd", /exactly one http/],
    ["rm -rf /", /only read-only gh, gog, git or curl/],
    ["gh pr view 1 | sh", /not a shell/],
    ["gh pr view $(whoami)", /not a shell/],
    ["gh pr view 1; rm x", /not a shell/],
    ["gh pr view 'unclosed", /unclosed quote/],
    ["gog chat messages send spaces/X --text oi", /gog is limited to reads/],
    ["gog sheets update ID A1 x", /gog is limited to reads/],
    ["gog gmail search is:unread", /gog is limited to reads/],
  ])("refuses %s", (command, error) => {
    const parsed = parseWatchCommand(command);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("keeps quoted text literal", () => {
    expect(splitWords(`gh pr view 1 --jq '.a | .b' "x y"`)).toEqual(["gh", "pr", "view", "1", "--jq", ".a | .b", "x y"]);
  });
});

describe("runWatchCommand", () => {
  it("runs without a shell and reports a missing program", async () => {
    const missing = await runWatchCommand(["definitely-not-a-cli-xyz"], { cwd: process.cwd(), path: process.env.PATH ?? "" });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toMatch(/not found/);
  });
});

describe("watchMatches", () => {
  it("uses a regex when valid and plain text otherwise", () => {
    expect(watchMatches('{"state":"MERGED"}', "merged|closed")).toBe(true);
    expect(watchMatches("x (y", "(y")).toBe(true);
    expect(watchMatches("pending", undefined)).toBe(false);
  });
});

describe("change detection on the whole output", () => {
  it("fingerprints everything even though only the start is kept", async () => {
    const big = "x".repeat(WATCH_OUTPUT_MAX + 5_000);
    const script = `process.stdout.write(${JSON.stringify(big)} + process.argv[1])`;
    const run = (tail: string) => runWatchCommand([process.execPath, "-e", script, tail], { cwd: process.cwd(), path: process.env.PATH ?? "" });
    const [a, b] = await Promise.all([run("A"), run("B")]);
    expect(a.output).toHaveLength(WATCH_OUTPUT_MAX);
    expect(a.output).toBe(b.output);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toBe(fingerprintOf(big + "A"));
  });
});
