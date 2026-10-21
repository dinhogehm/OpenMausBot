# OpenMausBot: terminal with Full Access

## Scope

Local macOS installation, based on `edca97568` (the installed responsiveness fix). No GitHub publication or Nuria release is part of this change.

The owner's persisted Full Access setting selects the CLI for delegated sessions, including requests that originally selected the Claude app. Each CLI turn reads the current grant. Claude receives `bypassPermissions`; the existing Codex driver uses `never` with `danger-full-access`. The public session API still cannot grant Full Access through a supplied permission string.

Historical app sessions retain their history. Full Access prevents native create, send, rename and archive actions; never-attempted queued starts stop without replay. Active or uncertain prior work is not silently migrated or duplicated. Hooks and project gates remain in place.

## Owner configuration

Saved through the native owner settings UI and independently reread from the running server:

- 12 of 12 bots have Full Access.
- 4,511 of 4,511 existing conversations have Full Access.
- The new-bot default has Full Access.
- QA Produção remains archived.

These are the requested configuration changes. All test writes use isolated synthetic data; no provider prompt was sent against the owner's real tasks for verification.

## Verification

The isolated delegated-session regression first reproduced the old `auto` launch mode, then passed with CLI Full Access. It checks explicit CLI, explicit app and omitted surface, rejects a caller-forged permission grant, preserves historical app sessions, and restores the original CLI permission mode after the owner revokes Full Access. Native app invocations are guarded and recorded. Synthetic project settings remain present; real provider hooks are not exercised.

The existing normal-driver transition tests for Claude and Codex passed: 4 tests passed, 459 skipped by the targeted filter `reapplies Full, Auto, and Ask`. This is targeted verification, not a claim that the entire repository suite ran.

Final source verification:

- Session and desktop queue tests: 107 passed.
- Catalog wire tests: 34 passed, including bundled proxy output. Goldens were regenerated for the Full descriptions; this also reconciled two already-stale routine overlap descriptions with the existing source. Profile byte budgets were remeasured without relaxing their limits.
- Isolated end-to-end fixture: 1 passed, 12 actions, 7.39 seconds. Four Full CLI launches and one resumed turn after revocation; zero native calls. Native synthetic records and transcripts remained byte-for-byte identical. The fixture was removed. See [fixture-summary.json](./fixture-summary.json).
- The fixture also confirms local-only archival releases a completed historical session's issue, refuses uncertain or unproven stopped sessions, and preserves the brief of a never-attempted start.
- Independent static review: no remaining blockers.
- `pnpm build`, `pnpm build:server`, `pnpm build:companion`, and `pnpm build:updater`: passed. Existing CSS `::highlight` and chunk-size warnings remain.

## Installed result

The local macOS app was rebuilt, signed, installed at `/Applications/OpenMausBot.app`, and reopened on 2026-10-21 at 10:07:26 America/Sao_Paulo. Version remains 0.1.114; Electron remains 43.7.9. Main PID was 93313 and the new API process was 93318. The health endpoint answered from that new process and the native UI loaded.

- `electron-builder --mac dir --arm64 --publish never`, with signing required: passed.
- Module scope check and `codesign --verify --deep --strict`: passed on the candidate; signature verification also passed after installation. Apple Development signing identity, team `9R829S6WS4`.
- Packaged-server smoke: all eight checks passed, including all 13 proxy paths, MCP stdio, bundled CLI, encrypted backup worker, container launcher, desktop compile cache, and enterprise loading. No real provider work was launched for this proof.
- Changed-file lint and `git diff --check`: passed.
- Installed `server/index.js` SHA-256 matches the candidate: `8a08af5b66ed14ec14ae80c76a983897fa9915703a346d78d2f3cfb2e5ba711a`.
- `app.asar` remains unchanged: `7d7002f22001b2ff7568d95f9986c4d89f3d36f6623d5bd352bf38296c895d18`.
- Runtime settings after restart: **12/12 bots and 4,513/4,513 conversations Full; new-bot default Full; QA Produção still archived**. New conversations created during the work inherited Full. There were no busy bots, queued messages, active tasks, or active delegated sessions immediately before quitting the old app.
- Warm `/api/bots?messages=0` samples after installation: 0.264, 0.197, 0.205 seconds. The prior responsiveness improvement is retained.
- Previous app backup: `/Users/osvaldo/OpenMausBot-backups/OpenMausBot-0.1.114-pre-terminal-full-20261021.app`.
- Signed candidate: `/Users/osvaldo/OpenMausBot-builds/terminal-full-20261021/mac-arm64/OpenMausBot.app`.

This verifies the local installation and isolated execution behavior. It does not claim a GitHub publication, a new Nuria release, or successful provider completion of the owner's existing tasks. Existing project hooks and delivery gates were not changed.
