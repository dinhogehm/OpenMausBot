# Coordination projection responsiveness

Base: `f1e2c67771593bb042697557c95daecfb5bea516`.

The installed app's loop-stall profiles showed repeated `readAssignment` /
`runtimeStore.all` calls under `awaitingTeammates -> wireTask -> wireBot`.
The user's store had 4,505 tasks and 13 live coordination assignments. A bot
projection now reads those assignments once, builds a snapshot of waiting
threads, and reuses it for its tasks. HTTP responses also reuse the tasks
already projected by `wireBot`. Snapshots are never retained across events.

## Verification

- New regression tests failed before the fix (1,000 reads rather than one,
  an earlier snapshot changing after mutation, and projected tasks not reused).
- `pnpm exec vitest run server/routes/threads-bots-list.test.ts server/host/coordination-waiting.test.ts`:
  five tests passed after the fix, including after test type corrections.
- The coordinator suite passed 78 of 79 tests. The remaining test,
  `completes the turn as it is when the RESULTADO reader throws, and logs why`,
  fails at `server/runtime-coordinator.test.ts:1433` on both this change and
  the untouched base commit. No parser/coordinator behavior was changed.
- Independent review checked direct/nested parents, room ownership, questions,
  empty questions, approval cards, `busy` / goal input masks and startup behavior.
- `pnpm build`, `pnpm build:server`, `pnpm build:companion`, `pnpm build:updater`,
  changed-file lint and `git diff --check` passed.
- Signed arm64 Electron 43.7.9 directory package passed module-scope checks,
  `codesign --verify --deep --strict` outside the sandbox, and the packaged-server
  smoke suite (isolated startup, 13 proxy paths, MCP, CLI, encrypted backup,
  launcher cleanup, compile-cache restart and enterprise module).
- Package keeps the existing team identity `9R829S6WS4` and no update feed.
  It is a local development-signed build, not a notarized public release.
  Built and packaged `server/index.js` SHA-256:
  `802714d5c58cab9465495192fc7fb28dfcb35474d940b119d71af9f824ac1fd6`.

## Isolated comparison

Official `launchVerificationServer` fixtures, all synthetic: one bot, 1,000
empty threads, 13 live assignments and 6,000 terminal assignments. The baseline
loaded the base commit's `server/index.ts` and `server/routes/threads.ts` through
a Node loader hook; the fixed run used current source. Both used the same
launcher, dependencies, seed and request sequence, run serially.

| Request | Base samples (ms) | Fixed samples (ms) |
| --- | --- | --- |
| `/api/bots?messages=0` | 417, 418, 415 | 7, 7, 7 |
| `/api/health`, started 20 ms later | 396, 397, 395 | 2, 2, 2 |

Both returned the same four waiting roots. Both passed `control-omb` send,
wait-until-settled and fake-provider reply checks. Each launcher closed its own
child and removed its temporary data. The fixed list request finishes before
the health probe begins. This measures the HTTP path, not renderer performance
or the entire production workload.

Local evidence for this run:

- `/private/tmp/omb-waiting-perf-20261021.mjs`
- `/private/tmp/omb-waiting-perf-comparison-20261021.json`
- `/private/tmp/omb-waiting-perf-nRi09V/result.json` (base)
- `/private/tmp/omb-waiting-perf-fGlBv6/result.json` (fixed)

## Installed local app

Installed in `/Applications/OpenMausBot.app` and reopened on 2026-10-21 at
12:28 UTC. Main PID 40323 and server PID 40328 were new; `lsof` confirmed the
server executable under `/Applications/OpenMausBot.app`. Its server bundle
matches the SHA-256 above. The previous app was preserved at
`/Users/osvaldo/OpenMausBot-backups/OpenMausBot-0.1.114-pre-responsiveness-20261021.app`.
No conversation databases or approvals were edited for the repair.

Read-only live measurements, about 4,508 tasks:

- Immediately before replacement, `/api/bots?messages=0`: **5.331950 s**.
- First request during new process startup: **4.245830 s**.
- Warm corrected requests: **0.205267 / 0.200250 / 0.203587 s**.
- Default `/api/bots` with message pages: **0.315985 s**; health: **0.000496 s**.
- UI loaded and the active-conversations panel opened through native UI control.

The initial startup still logged a 3.3-second stall involving process spawning,
filesystem reads and Codex rollout discovery. This change does not claim to
eliminate startup latency or renderer CPU usage. The live before/after samples
are observational, with scheduled routines running after startup; the isolated
comparison above is the controlled regression evidence.
