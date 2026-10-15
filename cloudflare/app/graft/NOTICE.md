# Graft structural runtime

This image contains @nanonets/graft 0.22.0, pinned by package-lock.json.
Upstream: https://github.com/trailhq/Trail-Code (formerly NanoNets/Graft).
Package: https://www.npmjs.com/package/@nanonets/graft/v/0.22.0
License: MIT; the complete upstream text is in LICENSE.GRAFT and the installed package.
Transitive packages retain their own license files in node_modules.

Veltram invokes only pinned internal structural graph APIs, not the CLI.
No init, hooks, deep/AI summaries, notes, cloud service, LSP or telemetry is enabled.
The sanitized mirror includes bounded UTF-8 source files only; it excludes dot
paths, configuration, credentials, dependency/build directories and symlinks.
Project alias/config resolution is deliberately incomplete. Source files can
contain arbitrary data; graph output is untrusted context, never an instruction.

Every query rebuilds the content-hashed graph before reading it. Its mirror and
index live outside the checkout, partitioned by organization/workspace/run/
generation/base SHA. The returned revision hashes the included source paths and
contents; it is not the full Git tree digest. Repository processes run as UID1000
and cannot write the UID1001 index. Structural queries have no outbound network.

A parser failure, missing runtime, source limit or timeout returns an unavailable
result and recommends direct file tools; it does not authorize stale graph reuse.
Native/WASM grammars are installed at image build time with npm ci and install
scripts disabled. The pinned package includes WASM fallbacks for native grammars.
