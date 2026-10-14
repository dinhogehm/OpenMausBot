# Veltram first cloud workflow implementation plan

**Goal:** Connect the approved multi-company foundation to a usable Veltram web interface and a durable, bounded Linux proof execution.

**Architecture:** Same-origin React assets and authenticated Worker API. An organization-scoped Durable Object owns proof runs and approvals; a global admission object bounds concurrent executors. Each attempt has its own Linux container identity. Durable state, rather than the browser connection, determines completion.

**Tech stack:** React, Vite, Workers, D1, SQLite Durable Objects and managed Cloudflare Containers.

## Confirmed product decisions

- Brand: Veltram. Domain `veltram.com` registered on 2026-10-14.
- All execution in Cloudflare, several companies from the start, each company supplies its own model keys.
- First interface: email-code login, company selection/creation, key administration and an explicitly labelled execution test. It must not present the proof command as an AI agent.
- Run input is a message and a bounded delay. Approval authorizes a fixed command that creates and reads a file, with no external network or provider calls.

## Tasks and verification

1. Add failing integration tests in `cloudflare/app/test/runs.integration.test.ts` for authenticated creation, tenant/workspace boundaries and idempotency.
2. Implement `src/run-room.ts`, `src/admission.ts` and authenticated routes in `src/index.ts`. Persist approval before dispatch, reject duplicate starts, fence late results, check current membership on every operation and again before dispatch. Bound history and global/per-company starts.
3. Implement `src/linux-executor.ts` using the currently documented container API. Only fixed commands, no provider secrets, bounded timeout/output, executor identity per tenant/workspace/run/generation. Verify the command with a disposable local Linux fixture.
4. Build the web app under `cloudflare/app/web/`, including real error, empty, pending, expired-session and role states. Never store keys in browser persistence. Abort/reset requests when switching company.
5. Integrate static assets and Veltram naming in the new package only. Keep the existing desktop and control-plane intact. Production resource IDs and secrets remain separate from local fixtures.
6. Verify tests, types, lint, build/dry-run and browser flows in disposable state. Review isolation, cancellation, restart uncertainty and stale callbacks independently.
7. Prepare the actual Cloudflare resource and email-domain setup. Inspect exact costs and missing configuration before any paid proof; production status requires deployment and functional evidence, not a local build.

## Recovery contract

Approval schedules a durable alarm. Before dispatch the coordinator stores the attempt generation and dispatch marker. If an alarm retries after dispatch, it marks the run interrupted rather than silently repeating execution. Cancellation fences the old generation. Only an exit-zero result with the expected artifact completes the proof. Artifact text is persisted with the run; later large artifacts will use R2.

## Limits for this proof

At most one leased execution per company, four globally, 30 starts per hour globally, 100 retained proof runs per company, 30-second input delay and a 60-second attempt lease. These are conservative technical limits, not an agreed infrastructure budget. The proof deliberately excludes arbitrary shell, model calls, imports and desktop control.
