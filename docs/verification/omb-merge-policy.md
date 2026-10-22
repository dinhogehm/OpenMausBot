# Scoped OMB merge policy

The local reviewer currently requires Nuria's `npm run pr:merge` for every
repository. OpenMausBot has no such command. The proposal in `scripts/policy/`
adds one host-pinned OMB command to the reviewer, without changing the Nuria
gate, its receipts, the STOP switch, GitHub protection, or other commands.
It runs the original classifier first and replaces only the exact generic
merge denial. Any other current or future decision remains authoritative.

The accepted form is exactly:

```sh
gh pr merge NUMBER --repo github.com/dinhogehm/OpenMausBot --merge --match-head-commit FULL_SHA
```

`NUMBER` is a positive PR number and `FULL_SHA` is the current 40-character
lowercase hexadecimal head. The repository and host are explicit, and GitHub
refuses a merge if that head changed. Required GitHub checks and protections
still apply. This exception does not provide a test verdict: before merging,
verify the candidate's tests and current remote state. Do not reuse this form
as a way to certify untested code.

The command must stand alone. Environment prefixes, shell wrappers, chaining,
redirection, alternative hosts/repositories, API merges, automatic merge,
branch deletion, short/missing SHAs and `--admin` receive the original policy
decision. STOP also blocks the OMB exception. The proposal neither publishes
a GitHub status nor fabricates a Nuria receipt.

## Verify without installing

```sh
node --test scripts/policy/omb-merge-scope.node-test.mjs
node scripts/policy/check-omb-merge-policy.cjs
```

The checker reads the existing policy, evaluates a candidate in memory and
compares unrelated decisions against the original policy. It writes no file.
`installed: false` means the proposal was verified, **not installed**.

## Owner installation

Agents must not install reviewer policy. After reviewing this proposal, the
owner runs the following directly in an interactive Terminal from this checkout:

```sh
node scripts/policy/install-omb-merge-policy.cjs --install
```

The UID and TTY checks verify file ownership and interactive execution; they
do not identify a human. Owner-only installation also relies on the existing
reviewer's protection against agent writes, which this proposal preserves.

The installer validates the candidate before writing, keeps a private backup
of the original bytes and atomically replaces the policy. It refuses an
unknown layout, partial previous installation, changed source, symlink,
hardlink or a file owned by another user. Repeating it is harmless.

Only `Política OMB instalada` or `Política OMB já instalada` confirms that the
policy is active. Installation never merges a PR, changes main, restarts the
app or modifies application data. The next agent command uses the new rule.
The printed backup can be restored by the owner if needed.
