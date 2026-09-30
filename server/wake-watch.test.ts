import { describe, expect, it } from "vitest";
import { fingerprintOf, parseWatchCommand, WATCH_READABLE_DIRS, runWatchCommand, splitWords, WATCH_OUTPUT_MAX, watchMatches } from "./wake-watch.ts";

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
    ["rm -rf /", /only read-only gh, gog, git, curl, or cat\/tail/],
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

  it("ignores stderr noise (a pager token) when deciding it changed, but still shows it", async () => {
    const script = "process.stdout.write('same messages'); process.stderr.write('# Next page: --page ' + process.argv[1])";
    const run = (token: string) => runWatchCommand([process.execPath, "-e", script, token], { cwd: process.cwd(), path: process.env.PATH ?? "" });
    const [a, b] = await Promise.all([run("abc"), run("xyz")]);
    expect(a.ok).toBe(true);
    expect(a.output).toContain("Next page: --page abc");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(fingerprintOf("same messages"));
  });
});

describe("local status files", () => {
  it("reads a file under ~/.nuria with cat or tail -n N, and nothing else", async () => {
    const { homedir } = await import("node:os");
    const home = homedir();
    expect(parseWatchCommand(`cat "~/.nuria/release-skipped.json"`)).toEqual({ ok: true, argv: ["cat", expect.stringMatching(/\.nuria\/release-skipped\.json$/)] });
    expect(parseWatchCommand(`tail -n 50 ${home}/.nuria/logs/production-release.err.log`)).toMatchObject({ ok: true, argv: ["tail", "-n", "50", expect.stringContaining(".nuria/logs/production-release.err.log")] });
    expect(parseWatchCommand(`cat ${home}/.ssh/id_ed25519`).ok).toBe(false);
    expect(parseWatchCommand(`cat ${home}/.nuria/../.ssh/id_ed25519`).ok).toBe(false);
    expect(parseWatchCommand(`tail -f ${home}/.nuria/x.log`).ok).toBe(false);
    expect(parseWatchCommand(`cat ${home}/.nuria/a ${home}/.nuria/b`).ok).toBe(false);
    expect(WATCH_READABLE_DIRS[0]).toBe(`${home}/.nuria`);
  });
});
