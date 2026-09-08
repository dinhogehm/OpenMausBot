# Preserve Codex launch paths across MCP mounts

## Problem and evidence

On macOS, a Finder launch supplies a minimal PATH. The Codex driver augments
it so the installed CLI and its `#!/usr/bin/env node` interpreter can start.
The browser integration also supplies PATH. Mounting it previously replaced
the augmented value, causing `codex exited 127 before turn/completed:
env: node: No such file or directory`, even when the engine probe succeeded.

## Chosen change

Merge PATH in the shared Codex MCP mount: retain the existing CLI directories
first, append integration-specific directories, and remove duplicates and
empty entries using the platform path delimiter. Route the phone bridge
through the same mount so it cannot undo the preservation later in setup.
Other environment values and per-server approval settings remain unchanged;
credential values still stay out of process arguments.

Changing the user's shell configuration would only work around the bug on
one computer. Changing only the browser's PATH would leave other integrations
able to reproduce the same failure. Neither is part of this fix.

## Acceptance and verification

- A real Node-shebang fake Codex completes its handshake and turn after a
  browser, custom MCP, or phone integration supplies a PATH without Node.
- CLI directories keep precedence, while additional MCP directories remain
  reachable across multiple mounts, including empty and duplicate paths.
- Existing Codex, browser, and path tests remain green.
- Build and lint pass; the server smoke uses isolated fixture data only.

## Scope

Code and local commit only. No application installation, live bot messages,
workflow restart, or change to delegation recovery. The observed SRE task
interruption at application shutdown is separate from this launch defect.

## Verification recorded on 2026-09-07

- Baseline: 101 passed, 7 skipped in the three focused suites below.
- Red: all four new regression cases failed before the implementation.
- Green: `pnpm exec vitest run server/drivers/codex.test.ts server/env-path.test.ts server/browser-engine.test.ts`
  completed with 105 passed and 7 skipped. Independent review reran the four
  new cases successfully and found no blocking code issues.
- `pnpm build` and `pnpm lint` exited 0. Existing lint warnings remain;
  Vite also reports its large-chunk warning.
- `pnpm test:packaged-server` exited 0: server started without node_modules,
  all nine proxy paths resolved, and packaged MCP stdio completed its probe.
- Isolated fixture: `control-omb.ts launch`, followed by `new-bot`, `send`,
  `wait`, and `messages`, all with explicit `--url http://127.0.0.1:20323`.
  The fixture bot `0c705cbb-645d-49e1-8536-0549f342b112` returned
  `hello from fake claude`; wait returned `settled`. This is a general server
  smoke check, not a real Codex/browser session. Codex-specific launch and
  completion are covered by the Node-shebang regression tests above.

The full repository test suite, installed desktop app, real browser session,
and native Windows execution were not verified in this commit-only change.
