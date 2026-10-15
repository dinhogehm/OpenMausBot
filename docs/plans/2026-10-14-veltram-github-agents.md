# Veltram: GitHub coding agents

## Goal

Connect selected GitHub repositories to each company, accept a coding task,
edit an isolated checkout in Cloudflare, execute real commands/tests and return
a draft pull request with evidence. First requested repository:
`dinhogehm/nuria-platform`. Never merge or deploy that repository automatically.

## Architecture

GitHub App OAuth uses a session/company-bound one-time state and PKCE. Only a
verified owner may delegate an installation; explicit repositories are selected
and installation ownership is unique across companies. App secrets and BYOK
keys remain in Workers. A trusted broker fetches a pinned archive and publishes
validated changed files through the Git Data API. The container receives code,
not credentials. Webhooks and per-step authorization fence revoked access.

A new durable coding coordinator per company and a per-run disposable container preserve
the existing fixed Linux proof. Each effect gets a durable dispatch marker;
unknown in-flight work interrupts on recovery rather than repeating commands.
Cancellation persists its fence before VM destruction, and capacity is released
only after confirmed teardown. Public dependency egress is explicitly bounded.

The user selected a ready, customizable coordinator/programmer/reviewer team.
The coordinator reads and submits a structured plan, the programmer edits and
tests, and the reviewer reads the changes and gives an explicit structured
verdict. The reviewer cannot run commands or write files. Rejected reviews and
failing final tests return to the programmer within a bounded repair budget.
Names, instructions and provider/model overrides are company-scoped and admin
editable with optimistic versioning. Tasks freeze the profiles at creation;
changing the preset does not change previously reviewed/approved tasks.

Model calls support the company's selected OpenAI, Anthropic or OpenRouter key.
Tasks freeze the model, setup/test commands and base ref at creation; approval
confirms that immutable request and starts its bounded execution window.
The UI distinguishes actual command exits from model statements and never calls
missing tests successful. A final test must run against the delivered change
manifest. Branches are exclusive `veltram/<runId>` and PRs are drafts.

## Technology

Cloudflare Workers, native Containers, Durable Objects, D1, React, existing
AES-GCM credentials, GitHub REST, provider-native model protocols. Bounded logs
stay in the per-run Durable Object in this initial slice; no unbounded logs or
additional artifact storage is necessary for the bounded receipts.

## Implementation and verification

1. `src/github*.ts`, `migrations/0003_github.sql`: OAuth, ownership, selection,
   revocation/webhook and source/publication broker. Adversarial isolated tests.
2. `src/coding-types.ts`, `coding-program.ts`, `coding-executor.ts`,
   `coding-network.ts`: bounded tools and VM lifecycle. Real isolated Linux
   fixture verifies editing, failing/passing tests, output limits and shutdown.
3. `src/model-broker.ts`, `coding-room.ts`, `coding-admission.ts`: model loop,
   explicit approval, durable state, cancellation, test evidence and PR result.
   Test tenant boundaries, revoked keys, crash/replay and late responses.
4. Routes/configuration/migrations: wire new bindings without changing prior
   resources or secret values. Read-only health does not certify the workflow.
5. `web/src/repositories.tsx`, `coding.tsx`: connect GitHub, select repository,
   submit/approve/cancel a task, inspect commands and PR. Isolated browser proof
   at desktop/mobile; no real user data used as a test fixture.
6. Prepare GitHub App registration with exact permissions and fixed callbacks.
   Operator confirms account ownership/installation in GitHub; no personal CLI
   token copied to the service. Real BYOK needed for a live model invocation.
7. Run focused tests, all cloud-app tests, types, lint, build and deploy dry run.
   Review, push and attach PR. Publish only after the concrete feature checks;
   separately report implementation, deployment and a demonstrated live run.

## Initial limits and unsupported cases

One active coding task per company, four globally; 30 minutes per task, 30
model calls, 240k accumulated tokens, 4k output tokens/call. Up to 100 changed
text files and 10 MiB total, 1 MiB/file, 32 KiB/tool output. JS/TS and Python
within the shipped image; private package registries, LFS, submodules and
workflow-file modifications require later explicit support. No production
credentials or deployment permissions are passed to repository tests.
