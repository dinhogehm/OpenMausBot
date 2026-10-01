import { describe, expect, it } from "vitest";
import { fingerprintOf, ignoreMatcher, newestStamp, parseWatchCommand, watchCommandWarnings, WATCH_READABLE_DIRS, runWatchCommand, splitWords, WATCH_OUTPUT_MAX, watchMatches } from "./wake-watch.ts";

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

describe("what a watch will not see", () => {
  it("warns about gog's oldest-first chat list and gh's created-order issue list", () => {
    expect(watchCommandWarnings("gog chat messages list spaces/AAQA4TXnzJ4 --plain")[0]).toContain('--order "createTime desc"');
    expect(watchCommandWarnings('gog chat messages list spaces/X --plain --max 10 --order "createTime desc"')).toEqual([]);
    expect(watchCommandWarnings("gh issue list --state all --limit 30 --json number,updatedAt")[0]).toContain("sort:updated-desc");
    expect(watchCommandWarnings('gh issue list --search "sort:updated-desc" --limit 40')).toEqual([]);
    expect(watchCommandWarnings("gh pr view 9300")).toEqual([]);
    expect(watchCommandWarnings('gog chat messages list spaces/X --json --max 2 --order "createTime desc"')[0]).toContain("nextPageToken");
  });

  it("finds the newest time stamp in an output", () => {
    expect(newestStamp("2026-03-16T19:19:20Z Cezar\n2026-03-31T10:00:00Z x")).toBe(Date.parse("2026-03-31T10:00:00Z"));
    expect(newestStamp("nothing dated")).toBeNull();
  });
});

describe("echo of the bot's own posts", () => {
  it("leaves ignored lines out of what decides a change", async () => {
    const run = (text: string) => runWatchCommand(["printf", text], { cwd: process.cwd(), path: process.env.PATH ?? "", ignore: "\\tOsvaldo Gehm\\t" });
    const before = await run("2026-09-30T18:10:00Z\\tDaiane\\terro no envio\\n");
    const echo = await run("2026-09-30T18:15:34Z\\tOsvaldo Gehm\\tRecebido, Daiane\\n2026-09-30T18:10:00Z\\tDaiane\\terro no envio\\n");
    const client = await run("2026-09-30T18:20:00Z\\tPedro\\tnovo relato\\n2026-09-30T18:15:34Z\\tOsvaldo Gehm\\tRecebido, Daiane\\n2026-09-30T18:10:00Z\\tDaiane\\terro no envio\\n");
    expect(echo.fingerprint).toBe(before.fingerprint);
    expect(echo.output).toContain("Osvaldo Gehm");
    expect(client.fingerprint).not.toBe(before.fingerprint);
    expect(ignoreMatcher("[unclosed")!("a [unclosed b")).toBe(true);
    expect(ignoreMatcher(undefined)).toBeNull();
  });

  it("warns about gog's oldest-first list with global flags before the command", () => {
    expect(watchCommandWarnings("gog --account o@x.com chat messages list spaces/X --plain")).toHaveLength(1);
    expect(watchCommandWarnings('gog --account o@x.com chat messages list spaces/X --order "createTime desc"')).toEqual([]);
  });
});

describe("page tokens", () => {
  it("do not make two runs of the same listing differ", () => {
    const a = '{\n  "messages": [{"text": "oi"}],\n  "nextPageToken": "f136f334f0c9"\n}';
    const b = '{\n  "messages": [{"text": "oi"}],\n  "nextPageToken": "c6f1c2084887"\n}';
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(a.replace("oi", "olá")));
  });
});
