# Terminal execution with the owner's Full level

The owner requested terminal execution in Full permission mode. Keep the
installed responsiveness fix and use existing durable permission settings:
Full for the current bots and their threads, and Full in the new-bot template.
Normal Claude and Codex bot drivers already run CLI subprocesses. Their Full
mappings are Claude `bypassPermissions` and Codex `approvalPolicy: never` with
`danger-full-access`.

Delegated Claude Code sessions must follow the source thread's server-resolved
Full level. A Full source selects CLI and `bypassPermissions`, including when
the request names the app surface. This internal selection must not let a
non-Full caller submit a forged bypass permission through the public parser.
Recheck the source level before a new CLI turn so revocation takes effect.

An old app session must not be resumed or sent new work by a Full source.
Preserve its transcript and reconcile existing activity. Do not migrate an
uncertain/running native session into a competing CLI process. For pending
work that has provably not started, stop holding a capacity reservation when
the app surface is no longer eligible. Automatic desktop work must use the
same source-level guard. Historical app sessions may be archived only in the
OMB ledger after the existing delivery checks and proof that the native turn
ended or was never attempted. Preserve queued instructions and native files.

Do not modify Git hooks, project gates, existing refusal records or provider
accounts. Full is the provider permission level, not authorization to retry
previously denied project actions.

Verify with focused unit tests and an official isolated fake-engine fixture:
Full source selects CLI+bypass, non-Full modes remain unchanged, stale native
queues cannot start, revocation removes bypass, and project settings remain
present without arguments that strip them. Then build and sign the local desktop package,
run its packaged-server smoke suite, replace the idle installed app with a
backup, and verify the installed bundle and persisted Full settings.
