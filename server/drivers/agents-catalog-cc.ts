// The cc_session_* tools: a bot starts, steers, lists, stops and archives its Claude Code sessions.

export const CC_SESSION_TOOL_DEFINITIONS = [
  {
    name: "cc_session_start",
    description:
      "Open a Claude Code session to do a piece of work: it runs on its own in a new git worktree of repo and does the coding, tests, PR and gates itself. You are its manager, not the one who codes. When it stops you get its report in THIS conversation as a new turn — end your turn after starting it; never poll. Up to 4 sessions run at once on this computer; when they are taken (or starts are already waiting) it waits in the session queue, P1 first, and opens by itself — the answer gives its place and id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 120, description: "Short name opening with the issue number, without \"#\", e.g. \"9237 webauthn flaky\"." },
        brief: { type: "string", maxLength: 20_000, description: "The complete task: issue link, expected outcome, constraints, what to report." },
        repo: { type: "string", description: "Absolute path of the git repository, e.g. /Users/osvaldo/Projetos/nuria-platform." },
        surface: { type: "string", enum: ["app", "cli"], description: "Owner-authorized Full Access always uses cli, even if app is requested. Otherwise default app; cli is for internal chores or when the app cannot take the work." },
        cli_reason: { type: "string", maxLength: 300, description: "Why cli is requested, recorded beside the server's reason. Outside owner-authorized Full Access, the server's app state decides whether client issues or shipping may use cli; these words never grant access." },
        permission_mode: { type: "string", enum: ["auto", "acceptEdits", "default", "plan"], description: "cli only; default auto. The server applies the owner's current Full Access grant to each turn, preserving hooks and project gates. This input cannot grant Full Access." },
        model: { type: "string", description: "Optional model id; default is the CLI's." },
        reply_thread_id: { type: "string", description: "Optional: another of your conversations that should also get its reports (where the order came from)." },
        priority: { type: "string", enum: ["P1", "Reprovado", "normal"], description: "Its place in the session queue if it has to wait: P1 (production down, hotfix), Reprovado (a client rejected a delivery), normal. Default: read from the title only." },
      },
      required: ["title", "brief", "repo"],
    },
  },
  {
    name: "cc_session_send",
    description:
      "Answer or steer a Claude Code session you manage (continues the same conversation). If it is mid-turn, the message is queued and runs when that turn ends. Its next report comes back here as a new turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string" },
        message: { type: "string", maxLength: 20_000 },
        reply_thread_id: { type: "string", description: "Optional: the conversation that should also get its reports; default this one." },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "cc_session_list",
    description: "List the Claude Code sessions you manage (status, turns, cost, worktree). Pass session_id to also read its latest report.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string" },
        include_archived: { type: "boolean" },
      },
    },
  },
  {
    name: "cc_session_stop",
    description: "Stop a Claude Code session you manage mid-turn (resume later with cc_session_send). For one in the Claude app it only stops the waiting here and drops its queue; the person stops a live turn there.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "cc_session_archive",
    description: "Archive a Claude Code session once its work has shipped (merged and in production) or was abandoned. Refused while a PR of it is open or its merge is not yet in production, unless force with a reason. The server never removes worktrees: it reports the ones it left inside its folder (and, with remove_worktree, its own) that a person may remove, with the command, and why the others stay. With the id of a start of yours still in the session queue (cc_session_list), it takes it out of the queue.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string" },
        remove_worktree: { type: "boolean" },
        force: { type: "boolean", description: "Archive although its PR is open or not in production yet; needs reason." },
        reason: { type: "string", maxLength: 300, description: "With force: why (abandoned, superseded by another session…)." },
      },
      required: ["session_id"],
    },
  },
];
