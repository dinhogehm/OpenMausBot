// Developer Certificate of Origin check for pull requests: every commit in
// base..head carries a `Signed-off-by:` trailer whose email matches the
// author (or the committer). Bot commits are skipped. Runs from the base
// branch's checkout and reads commit metadata only, so an untrusted pull
// request never executes anything here.
//
//   node scripts/check-dco.mjs <base-ref> <head-ref>
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/** Commits in base..head with author, committer and full message. */
export function commitsBetween(base, head) {
  return git("log", "--format=%H %ae %ce", `${base}..${head}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, committer] = line.split(" ");
      return { sha, author: author.toLowerCase(), committer: (committer ?? "").toLowerCase(), body: git("log", "-1", "--format=%B", sha) };
    });
}

export function signedOff(commit) {
  if (/\[bot\]/.test(commit.author)) return true;
  const emails = [...commit.body.matchAll(/^Signed-off-by:\s*.*<([^>]+)>\s*$/gim)].map((match) => match[1].toLowerCase());
  return emails.includes(commit.author) || emails.includes(commit.committer);
}

export function main(base, head) {
  const commits = commitsBetween(base, head);
  if (!commits.length) {
    console.log("no commits to check");
    return 0;
  }
  const missing = commits.filter((commit) => !signedOff(commit));
  if (missing.length) {
    console.error(`${missing.length} of ${commits.length} commit(s) lack a matching Signed-off-by line:`);
    for (const commit of missing) console.error(`  ${commit.sha.slice(0, 10)}  ${commit.author}`);
    console.error("\nfix: `git rebase --signoff <base>` then force-push; for new commits, `git commit -s`");
    console.error("why: LICENSING.md (Developer Certificate of Origin)");
    return 1;
  }
  console.log(`all ${commits.length} commit(s) signed off`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check-dco.mjs")) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: node scripts/check-dco.mjs <base-ref> <head-ref>");
    process.exit(2);
  }
  process.exit(main(base, head));
}
