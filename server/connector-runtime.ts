// Connector, skill-proposal, secret and sign-in cards a bot shows in its threads, and the turn places they ride on.
import type { ExternalRuntimeGrant } from "./external-runtime.ts";
import type { createRoomAccess } from "./host/room-access.ts";
import type { createBrowserHost } from "./host/browser.ts";
import { createHash, randomUUID } from "node:crypto";
import { type ServerResponse } from "node:http";
import { credentialIsConfigured } from "../shared/credential-request.ts";
import { isPendingSignInRequest, normalizeSignInSite, signInFallbackText, signInOutcome, signInResumePrompt } from "../shared/sign-in-request.ts";
import { appendDecision } from "./decision-log.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import {
  messageAttachmentName,
  messageFileRoots,
} from "./message-file.ts";
import { teamComputerOwner } from "./team-computers.ts";
import { type SignInRequestCardData } from "../shared/wire.ts";
import {
} from "./cloud-backend.ts";
import { createSkillReview } from "./skill-review.ts";
import { canAccessTeam, coordinatorSupervises } from "./peer-roster.ts";
import { containerRuntimeStatus, type LocalVmTarget } from "./container-computer.ts";
import { loadConfig, builtInBrowserEnabled, stripWorkspaceCredentialEnv, PROVIDER_CREDENTIAL_ENV, DATA_DIR } from "./config.ts";
import { ComputerControl } from "./computer-control.ts";
import { augmentedPath } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { Store, type BotRecord, type GroupRecord, type Message } from "./store.ts";
import { type TurnOwner } from "./turn-resources.ts";
import { workspaceDir } from "./workspace.ts";
import { applyStagedSkillWrite, applySkillWriteWithReceipt, getStagedSkillWrite, listStagedSkillWrites, rejectStagedSkillWrite, stageSkillWrite } from "./skills.ts";
import { previousSkillVersion, skillCardCopy, skillRequestReferences } from "./skill-request-card.ts";
import { skillReferencesSha256 } from "./skill-storage.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import { type ComputerPromptKind, savedLoginsPrompt } from "./system-prompt.ts";
import { redactSecretsInText } from "./redact.ts";
import { BROWSER_CONTROL_REFUSAL, browserRuntimeEnv } from "./browser-runtime.ts";
import { HeldSecrets, LoginStore } from "./login-store.ts";
import { fillLogin, fillLoginOn } from "./login-fill.ts";
import { cuaMcpInput, firefoxProbe, vmLoginPage } from "./vm-firefox-login.ts";
import { BotLogins, cardLoginPlace, cardSignInElsewhere, observeSignInPage, type ObservedPage } from "./bot-logins.ts";
import { stepContext } from "./browser-steps.ts";
import { parseLoginFields, parseTotpField } from "./routes/logins.ts";
import { loginSite, savedLoginResumePrompt } from "../shared/logins.ts";
import { type DirectApply } from "./direct-apply.ts";
import { type AutoVmClaimTable } from "./auto-vm-claims.ts";
import { controlRefusal, type ControlState } from "./control-client.ts";
import { parseSurface, type Surface } from "./surface.ts";
import { PhoneSecretBridge, PhoneSecretError, PhoneSecretSubmissionRegistry, assertPhoneSecretRequestMatches, phoneSecretOperationId, type PhoneSecretContext } from "./phone-secret.ts";
import { json } from "./harness/http.ts";

export type InternalCapability = {
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: "agents" | "connectors" | "computer" | "browser" | "hooks" | "phone" | "data" | "highlevel";
  skillAuthoring: boolean;
  createdBots: number;
  createdRooms?: number;
  openedThreads: number;
  orphanExpiresAt: number;
  localVmTarget?: LocalVmTarget;
  teamComputerId?: string;
  /** Set only by the harness at attach; null: mounted, and the first call creates or wakes the Boat. */
  boxId?: string | null;
  browserSession?: string;
  roomHandoffId?: string;
  attachedFiles?: number;
  /** attach_file may also deliver files saved outside the conversation's folders. Never on a Cloud home or a hosted workspace. */
  deliversSavedFiles?: boolean;
  turnStartedAt?: number;
  roomPosts?: number;
  delegatedThisTurn?: Set<string>;
  externalRuntime?: ExternalRuntimeGrant;
};

export interface ConnectorRuntimeDeps {
  roomSetupPending: ReturnType<typeof createRoomAccess>["roomSetupPending"];
  browserLive: ReturnType<typeof createBrowserHost>["browserLive"];
  currentBrowserSession: ReturnType<typeof createBrowserHost>["currentBrowserSession"];
  loginInput: ReturnType<typeof createBrowserHost>["loginInput"];
  browserSystemPrompt: ReturnType<typeof createBrowserHost>["browserSystemPrompt"];
  currentBrowserSpec: ReturnType<typeof createBrowserHost>["currentBrowserSpec"];
  browserRuntime: ReturnType<typeof createBrowserHost>["browserRuntime"];
  answerCardNode: (threadId: string, messageId: string, text: string) => boolean;
  autoVmClaims: AutoVmClaimTable;
  botComputerControlKey: (bot: BotRecord) => string;
  botForThread: (botId: string, threadId: string) => BotRecord | null;
  botLogins: BotLogins;
  cfg: ReturnType<typeof loadConfig>;
  claimTurnResource: (owner: TurnOwner, resource: string) => boolean;
  computerCallGate: (internalCapability: InternalCapability, signal?: AbortSignal) => Promise<ControlState>;
  computerControl: ComputerControl;
  botComputerControlSnapshot: (botId: string) => { held: boolean };
  touchLocalVm: (target: LocalVmTarget) => void;
  connectionUpdateText: (labels: readonly string[]) => string;
  credentialUpdateText: (label: string, outcome: "provided" | "dismissed") => string;
  fullAccessForSource: (botId: string, threadId: string) => boolean;
  heldSecrets: HeldSecrets;
  internalCapabilityIsActive: (capability: InternalCapability) => boolean;
  liveTurnByThread: Map<string, string>;
  localVmThreadTargets: Map<string, LocalVmTarget>;
  logins: LoginStore;
  notify: (notification: Notification | null) => void;
  phoneSecrets: PhoneSecretBridge;
  skillReview: ReturnType<typeof createSkillReview>;
  skillsHost: ReturnType<typeof createSkillsLibraryHost>;
  store: Store;
  teamComputerTurns: Map<string, { owner: TurnOwner; computerId: string; botId: string }>;
  turnPlaces: Map<string, { botId: string; place: Surface }>;
}

/** Built once, where server/index.ts used to declare all of this inline. */
export function createConnectorRuntime(deps: ConnectorRuntimeDeps) {
  const { roomSetupPending, browserLive, currentBrowserSession, loginInput, browserSystemPrompt, currentBrowserSpec, browserRuntime, answerCardNode, autoVmClaims, botComputerControlKey, botForThread, botLogins, cfg, claimTurnResource, computerCallGate, computerControl, botComputerControlSnapshot, touchLocalVm, connectionUpdateText, credentialUpdateText, fullAccessForSource, heldSecrets, internalCapabilityIsActive, liveTurnByThread, localVmThreadTargets, logins, notify, phoneSecrets, skillReview, skillsHost, store, teamComputerTurns, turnPlaces } = deps;
  const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

  /** The name the person gave an attachment, from the newest of this thread's messages that carries its exact tag. */
  function attachmentNameInThread(threadId: string, path: string): string | null {
    const messages = store.messagesFor(threadId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = messages[i]!.text;
      const name = text ? messageAttachmentName(text, path) : null;
      if (name) return name;
    }
    return null;
  }

  function messageFileRootsForThread(senderId: string, threadId: string): string[] {
    const directBot = store.botByThread(threadId);
    const group = directBot ? undefined : store.groupByThread(threadId);
    let pinnedCwd: string | null | undefined;
    let configuredCwd: string | undefined;
    if (directBot) {
      pinnedCwd = store.taskByThread(directBot.id, threadId)?.cwd;
      configuredCwd = directBot.cwd;
    } else if (group) {
      const task = store.groupTaskByThread(group.id, threadId);
      pinnedCwd = task ? task.pinnedCwd : group.threadId === threadId ? group.pinnedCwd : undefined;
      configuredCwd = group.cwd;
    }
    return messageFileRoots({
      senderWorkspace: workspaceDir(senderId),
      attachments: ATTACHMENTS_DIR,
      pinnedCwd,
      configuredCwd,
    });
  }

  async function attachmentVmForTurn(capability: InternalCapability): Promise<LocalVmTarget | undefined> {
    const slot = autoVmClaims.get(capability.threadId);
    if (!localVmThreadTargets.has(capability.threadId) &&
        !(slot?.localVm && slot.owner.generation === capability.generation)) return undefined;
    const gate = await computerCallGate(capability);
    if (gate.held) throw Object.assign(new Error(controlRefusal(gate)), { status: 409 });
    const vm = localVmThreadTargets.get(capability.threadId);
    if (!vm || !internalCapabilityIsActive({ ...capability, localVmTarget: vm })) {
      throw Object.assign(new Error("This turn no longer owns the Local VM."), { status: 409 });
    }
    return vm;
  }

  function connectorThread(botId: string, threadId: string) {
    const bot = store.bot(botId);
    if (!bot) return null;
    if (bot.threadId === threadId) return { bot, group: undefined };
    if (store.taskByThread(botId, threadId)) return { bot, group: undefined };
    const group = store.groupByThread(threadId);
    if (group?.memberIds.includes(botId)) return { bot, group };
    return null;
  }

  /** Read fresh every time; a line stamped via the HTTP API does not count, so a bot cannot re-arm the ceiling it just spent. */
  function lastHumanRoomMessageAt(group: GroupRecord): number | undefined {
    const messages = store.messagesFor(group.threadId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === "user" && message.kind === "text" && !message.via) return message.at;
    }
    return undefined;
  }

  /** Refuses cross-section rooms outright, so a tool is never the way one section speaks to another; membership comes from the record, never a tool argument. */
  function roomPostEligibility(
    bot: BotRecord,
    group: GroupRecord,
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (group.dm) {
      return {
        ok: false,
        status: 400,
        error: "that is a one-to-one bot channel, not a room — use coordinate_bots to reach a single bot",
      };
    }
    if (!group.memberIds.includes(bot.id)) {
      return { ok: false, status: 403, error: "you are not a member of that room" };
    }
    const outsider = group.memberIds
      .map((id) => store.bot(id))
      .find((member) => member && !canAccessTeam(bot, member.section) && !coordinatorSupervises(member, bot));
    if (outsider) {
      return {
        ok: false,
        status: 403,
        error: `that room includes @${outsider.name}, who is outside your section — tell the user what you wanted to post there instead`,
      };
    }
    // A bot must never settle whether a room's unfinished setup still counts as pending.
    if (roomSetupPending(group)) {
      return { ok: false, status: 409, error: "that room is still being set up — it cannot receive messages yet" };
    }
    return { ok: true };
  }

  function proposalPersistence(botId: string, threadId: string, opensCard = true) {
    if (!store.bot(botId)) {
      return { ok: false as const, status: 403, error: "unknown sender" };
    }
    if (!connectorThread(botId, threadId)) {
      return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
    }
    if (!opensCard || fullAccessForSource(botId, threadId)) return { ok: true as const };
    const openRequests = store.activePath(threadId).filter(
      (message) =>
        (message.card?.routineRequest?.botId === botId || message.card?.profileRequest?.botId === botId || message.card?.modelRequest?.botId === botId || message.card?.teamSetupRequest?.botId === botId) &&
        !message.card.answered &&
        !message.card.dismissed && !message.card.expired,
    ).length;
    return openRequests >= 8
      ? { ok: false as const, status: 429, error: "confirm or cancel an existing proposal first" }
      : { ok: true as const };
  }

  function skillProposalPersistence(botId: string, threadId: string, opensCard = true) {
    if (!store.bot(botId)) {
      return { ok: false as const, status: 403, error: "unknown sender" };
    }
    if (!connectorThread(botId, threadId)) {
      return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
    }
    if (!opensCard || fullAccessForSource(botId, threadId)) return { ok: true as const };
    const openRequests = store.activePath(threadId).filter(
      (message) =>
        message.card?.skillRequest?.botId === botId &&
        !message.card.answered &&
        !message.card.dismissed,
    ).length;
    return openRequests >= 8
      ? { ok: false as const, status: 429, error: "confirm or cancel an existing learned-skill card first" }
      : { ok: true as const };
  }

  /** Lifecycle metadata only: the exact review copy lives only on the durable approval card. */
  function stagedSkillListing(staged: ReturnType<typeof listStagedSkillWrites>[number]) {
    const { files: _files, baseSha256: _baseSha256, baseAppliedStageId: _baseAppliedStageId, ...listing } = staged;
    return listing;
  }

  /** Ownership comes from the server-authored sender, never the card payload. */
  function stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }> {
    const directOwner = store.botByThread(threadId)?.id;
    const seen = new Set<string>();
    const cleanups: Array<{ botId: string; stagedId: string }> = [];
    for (const message of store.messagesFor(threadId)) {
      const request = message.card?.skillRequest;
      const botId = message.from?.botId ?? directOwner;
      if (!request || !botId) continue;
      const key = `${botId}:${request.stagedId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleanups.push({ botId, stagedId: request.stagedId });
    }
    return cleanups;
  }

  function rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void {
    for (const cleanup of cleanups) rejectStagedSkillWrite(cleanup.botId, cleanup.stagedId);
  }

  function applyOwnStagedSkill(
    from: BotRecord,
    threadId: string,
    staged: Exclude<ReturnType<typeof stageSkillWrite>, { error: string }>,
    direct: DirectApply,
  ): ReturnType<typeof applySkillWriteWithReceipt> & { shared?: string; shareError?: string } {
    const previous = previousSkillVersion(from.id, staged);
    const applied = applySkillWriteWithReceipt(from.id, staged, () => {
      const receipt = appendSkillRequestCard({ botId: from.id, threadId, staged, applied: true, previous });
      appendDecision(DATA_DIR, { threadId, requestId: receipt.requestId, botId: from.id, botName: from.name,
        tool: "stage_skill", summary: receipt.summary, decision: "auto-approved", source: direct });
    });
    if ("error" in applied) rejectStagedSkillWrite(from.id, staged.id);
    return "error" in applied ? applied : skillsHost.afterOwnApply(from.id, threadId, staged, applied);
  }

  function appendSkillRequestCard(args: {
    botId: string;
    threadId: string;
    applied?: boolean;
    previous?: SkillRequestCardData["previous"];
    staged: {
      id: string;
      action: "create" | "update";
      name: string;
      gist: string;
      source: string;
      files: Array<{ path: string; content: string }>;
      sha256: string;
      referencesSha256?: string;
      warnings: string[];
    };
  } & Pick<SkillRequestCardData, "shared">): { requestId: string; summary: string } {
    const requestId = randomUUID();
    const copy = skillCardCopy(args.staged);
    const payload: SkillRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      stagedId: args.staged.id,
      action: args.staged.action,
      name: args.staged.name,
      gist: args.staged.gist,
      source: args.staged.source,
      preview: args.staged.files.find((file) => file.path === "SKILL.md")?.content ?? "",
      sha256: args.staged.sha256,
      ...skillRequestReferences(args.staged),
      warnings: args.staged.warnings,
      createdAt: Date.now(),
      ...(args.applied ? { ...(args.previous ? { previous: args.previous } : {}), ...(args.shared ? { shared: args.shared } : {}) } : {}),
    };
    const from = store.bot(args.botId);
    skillReview.noteSkillChange(args.botId, args.threadId);
    store.appendMessage(args.threadId, {
      role: "bot",
      kind: "options",
      from: from ? { botId: from.id, name: from.name, color: from.color } : undefined,
      card: {
        title: copy.title,
        subtitle: copy.subtitle,
        options: args.applied ? [] : [args.staged.action === "create" ? "Enable" : "Update", "Deny"],
        ...(args.applied ? { answered: "allow", autoApplied: true, title: `Skill "${args.staged.name}" ${args.staged.action === "create" ? "enabled" : "updated"}` } : {}),
        requestId,
        tool: copy.tool,
        skillRequest: payload,
      },
    });
    return {
      requestId,
      summary: `${copy.title} ${args.staged.gist}`.trim(),
    };
  }

  function resolveSkillRequest(args: {
    botId: string;
    botName?: string;
    threadId: string;
    requestId: string;
    behavior: "allow" | "deny" | "answer";
    reviewedSha256?: string;
  }):
    | { claimed: false }
    | { claimed: true; status: number; error: string }
    | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true } {
    const message = store.messagesFor(args.threadId).find(
      (candidate) => candidate.card?.requestId === args.requestId && candidate.card.skillRequest,
    );
    const card = message?.card;
    const request = card?.skillRequest;
    if (!request || !card || !message) return { claimed: false };
    if (request.botId !== args.botId) {
      return { claimed: true, status: 403, error: "this skill request belongs to a different bot" };
    }
    if (card.answered || card.dismissed) {
      const cleanup = rejectStagedSkillWrite(args.botId, request.stagedId);
      if ("applied" in cleanup && cleanup.applied && card.answered !== "allow") {
        store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", dismissed: false, held: undefined },
        });
        return { claimed: true, outcome: "allowed-once", alreadySettled: true };
      }
      return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
    }
    if (args.behavior !== "allow") {
      const rejected = rejectStagedSkillWrite(args.botId, request.stagedId);
      if ("error" in rejected && rejected.error !== "no such staged skill") {
        return { claimed: true, status: 409, error: rejected.error };
      }
      if ("applied" in rejected) {
        store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", dismissed: false, held: undefined },
        });
        appendDecision(DATA_DIR, {
          threadId: args.threadId,
          requestId: args.requestId,
          botId: args.botId,
          botName: args.botName,
          tool: card.tool,
          summary: card.subtitle,
          decision: "user-approved",
          source: "user",
        });
        return { claimed: true, outcome: "allowed-once" };
      }
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "deny", dismissed: true, held: undefined },
      });
      appendDecision(DATA_DIR, {
        threadId: args.threadId,
        requestId: args.requestId,
        botId: args.botId,
        botName: args.botName,
        tool: card.tool,
        summary: card.subtitle,
        decision: "user-denied",
        source: "user",
      });
      return { claimed: true, outcome: "rejected" };
    }
    if (typeof request.preview !== "string" || typeof request.sha256 !== "string") {
      return {
        claimed: true,
        status: 409,
        error: "this proposal was created by an older build — deny it and ask the bot to create it again",
      };
    }
    if (args.reviewedSha256 !== request.sha256) {
      return {
        claimed: true,
        status: 409,
        error: "reviewedSha256 must match the skill shown on the approval card",
      };
    }
    const previewSha256 = createHash("sha256").update(request.preview).digest("hex");
    if (previewSha256 !== request.sha256 || skillReferencesSha256(request.references ?? []) !== request.referencesSha256) {
      return { claimed: true, status: 422, error: "the skill preview changed after review — deny and recreate it" };
    }
    const staged = getStagedSkillWrite(args.botId, request.stagedId);
    if (!staged) {
      const replayed = applyStagedSkillWrite(args.botId, request.stagedId, {
        expectedSha256: request.sha256,
        expectedReferencesSha256: request.referencesSha256 ?? null,
      });
      if (
        "error" in replayed ||
        replayed.name !== request.name ||
        replayed.source !== request.source
      ) {
        return {
          claimed: true,
          status: 422,
          error: "the staged skill no longer matches this approval card",
        };
      }
      const patched = store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined },
      });
      if (!patched) {
        return { claimed: true, status: 409, error: "the learned-skill approval card is no longer available" };
      }
      appendDecision(DATA_DIR, {
        threadId: args.threadId,
        requestId: args.requestId,
        botId: args.botId,
        botName: args.botName,
        tool: card.tool,
        summary: card.subtitle,
        decision: "user-approved",
        source: "user",
      });
      return { claimed: true, outcome: "allowed-once" };
    }
    if (
      request.requestId !== args.requestId ||
      request.threadId !== args.threadId ||
      staged.action !== request.action ||
      staged.name !== request.name ||
      staged.source !== request.source ||
      staged.sha256 !== request.sha256 ||
      staged.referencesSha256 !== request.referencesSha256
    ) {
      return { claimed: true, status: 422, error: "the staged skill no longer matches this approval card" };
    }
    const applied = applyStagedSkillWrite(args.botId, request.stagedId, {
      expectedSha256: request.sha256,
      expectedReferencesSha256: request.referencesSha256 ?? null,
      onApplied: () => {
        const patched = store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined },
        });
        if (!patched) throw new Error("the learned-skill approval card is no longer available");
      },
    });
    if ("error" in applied) {
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, held: applied.error },
      });
      return { claimed: true, status: 422, error: applied.error };
    }
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card.tool,
      summary: card.subtitle,
      decision: "user-approved",
      source: "user",
    });
    return { claimed: true, outcome: "allowed-once" };
  }

  function sendSkillResolution(
    res: ServerResponse,
    result: ReturnType<typeof resolveSkillRequest>,
  ): boolean {
    if (!result.claimed) return false;
    if ("error" in result) {
      json(res, result.status, { error: result.error });
      return true;
    }
    json(res, 200, { ok: true, outcome: result.outcome, alreadySettled: result.alreadySettled });
    return true;
  }

  function connectorMessage(botId: string, threadId: string, messageId: string) {
    if (!connectorThread(botId, threadId)) return null;
    const message = store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    return message?.kind === "connector" && message.connector ? message : null;
  }

  function connectorCards(threadId: string, resumeKey: string) {
    return store.messagesFor(threadId).filter(
      (message) => message.kind === "connector" && message.connector?.resumeKey === resumeKey,
    );
  }

  function maybeResumeConnectors(threadId: string, resumeKey: string) {
    const cards = connectorCards(threadId, resumeKey);
    if (!cards.length || cards.some((message) => message.connector?.dismissed || message.connector?.status !== "connected")) return false;
    if (cards.every((message) => message.connector?.resumed)) return true;
    const labels = cards.map((message) => message.connector!.label);
    if (!answerCardNode(threadId, cards[0]!.id, connectionUpdateText(labels))) return true;
    for (const message of cards) {
      store.patchMessage(threadId, message.id, { connector: { ...message.connector!, resumed: true, error: undefined } });
    }
    return true;
  }


  const phoneSecretSubmissions = new PhoneSecretSubmissionRegistry();

  function claimPhoneSecretBotDeletion(botId: string): (() => void) | null {
    const scopes = [
      { botId },
      ...store.groups
        .filter((group) => group.memberIds.includes(botId))
        .map((group) => ({ groupId: group.id })),
    ];
    const releases: Array<() => void> = [];
    for (const scope of scopes) {
      const release = phoneSecretSubmissions.claimMutation(scope);
      if (!release) {
        for (const undo of releases.reverse()) undo();
        return null;
      }
      releases.push(release);
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  function phoneSecretSubmissionKey(threadId: string, messageId: string, requestKey: string): string {
    return `${threadId}:${messageId}:${requestKey}`;
  }

  function credentialDesktopHandoff(label: string): string {
    return `Securely provide the ${label} from OpenMausBot on your phone or computer. It is never added to chat.`;
  }

  function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
    const owner = connectorThread(botId, threadId);
    if (!owner) return null;
    // Actionable only on the visible branch; in a channel only the requesting bot may bind the credential into HPKE AAD or resume its turn.
    const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
    if (owner.group && message?.from?.botId !== botId) return null;
    return message?.kind === "secret" && message.secret ? message : null;
  }

  function currentSecretState(botId: string, threadId: string, messageId: string) {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return null;
    return {
      provided: message.secret.provided === true,
      resumed: message.secret.resumed === true,
    };
  }

  function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: "provided" | "dismissed") {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return false;
    if (message.secret.resumed) return true;
    const resumed = answerCardNode(threadId, messageId, credentialUpdateText(message.secret.label, outcome));
    store.patchMessage(threadId, message.id, {
      secret: {
        ...message.secret,
        provided: outcome === "provided" ? true : message.secret.provided,
        dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
        ...(resumed ? { resumed: true, error: undefined } : {}),
      },
    });
    return true;
  }

  async function provideSecretFromPhone(
    context: PhoneSecretContext,
    authenticatedDeviceId: string,
  ): Promise<{ provided: boolean; resumed: boolean }> {
    const owner = connectorThread(context.botId, context.threadId);
    const message = secretMessage(context.botId, context.threadId, context.messageId);
    if (!owner || !message?.secret) throw new PhoneSecretError("No such credential request", 404);
    if (message.secret.dismissed) throw new PhoneSecretError("This credential request was dismissed", 409);
    if (message.secret.superseded) throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
    assertPhoneSecretRequestMatches(context, authenticatedDeviceId, {
      target: message.secret.target,
      requestKey: message.secret.requestKey,
    });
    const operationId = phoneSecretOperationId(context);
    if (message.secret.phoneOperationId && message.secret.phoneOperationId !== operationId) {
      throw new PhoneSecretError(
        "This credential request was already completed by another submission",
        409,
      );
    }
    // Recording the winning operation precedes completing the card, so an exact retry repairs a crash without writing the credential again.
    if (message.secret.phoneOperationId === operationId && !message.secret.provided) {
      if (!credentialIsConfigured(botLogins.credentialConfig(cfg), message.secret.target)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }
    if (message.secret.provided) {
      if (message.secret.phoneOperationId !== operationId) {
        throw new PhoneSecretError(
          "This credential request was already completed by another submission",
          409,
        );
      }
      if (!credentialIsConfigured(botLogins.credentialConfig(cfg), message.secret.target)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!message.secret.resumed && !resumeSecretCard(
        context.botId,
        context.threadId,
        context.messageId,
        "provided",
      )) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }

    const submissionKey = phoneSecretSubmissionKey(context.threadId, context.messageId, context.requestKey);
    await phoneSecretSubmissions.run({
      cardKey: submissionKey,
      botId: context.botId,
      threadId: context.threadId,
      ...(owner.group ? { groupId: owner.group.id } : {}),
    }, operationId, async () => {
      await phoneSecrets.provide(context);
      const current = secretMessage(context.botId, context.threadId, context.messageId);
      if (!current?.secret || current.secret.requestKey !== context.requestKey) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      if (current.secret.dismissed) {
        throw new PhoneSecretError("This credential request was dismissed", 409);
      }
      // The card may have been superseded during the save: completing it would leave two cards resolved.
      if (current.secret.superseded) {
        throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
      }
      // Electron acknowledges only after credentials.bin and the config update both commit; keep this assertion so no handler resumes first.
      if (!credentialIsConfigured(botLogins.credentialConfig(cfg), current.secret.target)) {
        throw new PhoneSecretError(`${current.secret.label} was not saved yet`, 409);
      }
      // Persist the winning envelope id before completing the card, so a new sealed value is never reported as the saved one.
      store.patchMessage(context.threadId, current.id, {
        secret: { ...current.secret, phoneOperationId: operationId },
      });
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
    });
    const settled = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!settled) throw new PhoneSecretError("This credential request is no longer available", 409);
    return settled;
  }

  // By design OpenMausBot never receives a website password: the person signs in where the bot works, and the bot uses that session.

  function recordTurnPlace(botId: string, threadId: string, place: Surface | null): void {
    if (place) turnPlaces.set(threadId, { botId, place });
    else turnPlaces.delete(threadId);
  }

  function signInPlace(bot: BotRecord, threadId: string): Surface | null {
    const turn = turnPlaces.get(threadId);
    if (turn?.botId === bot.id) return turn.place;
    return store.taskByThread(bot.id, threadId)?.surface ?? parseSurface(bot.computer) ?? null;
  }

  function signInControlKey(bot: BotRecord, threadId: string, place: Surface): string {
    if (place === "browser") return bot.id;
    const team = teamComputerTurns.get(threadId);
    return team?.botId === bot.id ? teamComputerOwner(team.computerId) : botComputerControlKey(bot);
  }

  /** Appends the new card first, so a failed append leaves the older one actionable. */
  function requestSignIn(from: BotRecord, threadId: string, rawSite: unknown, rawReason: unknown):
    { messageId: string; site: string; place: Surface } | { status: number; error: string } {
    const owner = connectorThread(from.id, threadId);
    if (!owner) return { status: 403, error: "source conversation does not belong to sender" };
    const target = normalizeSignInSite(rawSite);
    if (!target) return { status: 400, error: "site must be a web address or a domain, such as example.com" };
    const place = signInPlace(from, threadId);
    if (!place) return { status: 409, error: "this conversation has no browser or computer for the person to sign in on" };
    const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 240) : "";
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "signin",
      text: signInFallbackText(from.name, target.site),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      signIn: { url: target.url, site: target.site, place, ...(reason ? { reason } : {}) },
    });
    for (const prior of store.activePath(threadId)) {
      if (prior.id === message.id || !prior.signIn || !isPendingSignInRequest(prior, target.site, from.id, Boolean(owner.group))) continue;
      store.patchMessage(threadId, prior.id, { signIn: { ...prior.signIn, superseded: true } });
      computerControl.settleHelp(prior.id);
    }
    computerControl.requestHelp(signInControlKey(from, threadId, place), `sign in to ${target.site}`,
      { botId: from.id, threadId, messageId: message.id, site: target.site, place });
    notify(buildNotification("sign-in", { ...from, threadId }, threadId, reason || `Open OpenMausBot to sign in to ${target.site}.`, {
      avatarUrl: from.avatarUrl,
      ...(owner.group ? { group: { id: owner.group.id, name: owner.group.name } } : {}),
      site: target.site,
    }));
    return { messageId: message.id, site: target.site, place };
  }

  /** In a room, only the asking bot's own card. */
  function signInMessage(botId: string, threadId: string, messageId: string): Message | null {
    const owner = connectorThread(botId, threadId);
    if (!owner) return null;
    const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
    if (owner.group && message?.from?.botId !== botId) return null;
    return message?.kind === "signin" && message.signIn ? message : null;
  }

  function settleSignIn(botId: string, threadId: string, messageId: string, outcome: "done" | "cancelled", saved?: { site: string }):
    { status: number; body: Record<string, unknown> } {
    const bot = store.bot(botId);
    const message = signInMessage(botId, threadId, messageId);
    if (!bot || !message?.signIn) return { status: 404, body: { error: "no such sign-in request" } };
    const card = message.signIn;
    if (card.superseded) return { status: 409, body: { error: "this sign-in request was superseded by a newer one" } };
    const settled = signInOutcome(card);
    if (settled && settled !== outcome) {
      return { status: 409, body: { error: `this sign-in request was already ${settled === "done" ? "marked done" : "cancelled"}` } };
    }
    if (settled && card.resumed) return { status: 200, body: { [outcome]: true, resumed: true } };
    if (!settled) {
      const pleaded = computerControl.settleHelp(message.id);
      if (card.place === "browser") browserLive.handBack(currentBrowserSession(bot.id, bot.browserProfile));
      else for (const key of pleaded.length ? pleaded : [botComputerControlKey(bot)]) computerControl.release(key);
    }
    const savedLogin = saved?.site ?? card.savedLogin;
    const resumed = answerCardNode(threadId, message.id, savedLogin ? savedLoginResumePrompt(savedLogin) : signInResumePrompt(card.site, outcome));
    store.patchMessage(threadId, message.id, {
      signIn: { ...card, ...(outcome === "done" ? { done: true } : { cancelled: true }), ...(savedLogin ? { savedLogin } : {}), ...(resumed ? { resumed: true, error: undefined } : {}) },
    });
    return { status: 200, body: { [outcome]: true, resumed, ...(savedLogin ? { saved: true, site: savedLogin } : {}) } };
  }

  /** The open sign-in card the person is answering, and the page its bot's browser shows (null when none a login could fill). */
  async function signInCardPage(botId: string, threadId: string, messageId: string):
    Promise<{ card: SignInRequestCardData; cardHost: string; observed: ObservedPage | null } | { status: number; body: Record<string, unknown> }> {
    const message = signInMessage(botId, threadId, messageId);
    const bot = store.bot(botId);
    if (!bot || !message?.signIn) return { status: 404, body: { error: "no such sign-in request" } };
    const card = message.signIn;
    if (card.superseded) return { status: 409, body: { error: "this sign-in request was superseded by a newer one" } };
    if (signInOutcome(card)) return { status: 409, body: { error: "this sign-in request was already answered" } };
    let cardHost: string;
    try { cardHost = new URL(card.url).hostname.toLowerCase(); }
    catch { return { status: 409, body: { error: "this sign-in request has no page address to save a login for" } }; }
    const browser = card.place === "browser" ? await botBrowserTarget(botForThread(botId, threadId) ?? bot).catch(() => null) : null;
    const observed = browser ? await observeSignInPage(loginInput(browser.session, browser.spec, browser.env).engine).catch(() => null) : null;
    return { card, cardHost, observed };
  }

  async function signInSaveTarget(botId: string, threadId: string, messageId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const page = await signInCardPage(botId, threadId, messageId);
    if ("status" in page) return page;
    const elsewhere = cardSignInElsewhere(page.cardHost, page.observed);
    return { status: 200, body: { site: loginSite(page.cardHost), ...(elsewhere ? { signInHost: elsewhere } : {}) } };
  }

  /** The login is saved before the card settles, so a refused or failed save leaves the card open. */
  async function saveLoginFromCard(botId: string, threadId: string, messageId: string, body: Record<string, unknown>):
    Promise<{ status: number; body: Record<string, unknown> }> {
    const fields = parseLoginFields(body, { passwordRequired: true });
    if (!fields.ok) return { status: 400, body: { error: fields.error } };
    const totp = parseTotpField(body.totp);
    if (!totp.ok) return { status: 400, body: { error: totp.error } };
    const page = await signInCardPage(botId, threadId, messageId);
    if ("status" in page) return page;
    const current = signInMessage(botId, threadId, messageId)?.signIn;
    if (!current || current.superseded || signInOutcome(current)) return { status: 409, body: { error: "this sign-in request was answered or replaced while the login was being saved" } };
    const place = cardLoginPlace(page.cardHost, page.observed, body.signInHost);
    logins.create({ ...place, username: fields.value.username ?? "", password: fields.value.password!, totp: totp.value ?? null, source: "card", bots: [botId] });
    const elsewhere = place.hosts.filter((host) => loginSite(host) !== place.site);
    return settleSignIn(botId, threadId, messageId, "done", { site: [place.site, ...elsewhere].join(" and ") });
  }

  /** Saved logins appear by site and username only. */
  function browserPromptFor(bot: { id: string; browserProfile?: string }, agentsMounted: boolean): string {
    return browserSystemPrompt(bot.browserProfile) + (agentsMounted ? savedLoginsPrompt(botLogins.sitesFor(bot.id)) : "");
  }

  /** Null while the browser engine is not installed. */
  async function botBrowserTarget(bot: BotRecord): Promise<{ session: string; spec: { command: string; env: Record<string, string> }; env: NodeJS.ProcessEnv } | null> {
    const target = await currentBrowserSpec(bot.id, bot.browserProfile);
    return target && { ...target, env: browserRuntimeEnv({ ...target.spec.env, AGENT_BROWSER_SESSION: target.session }) };
  }

  function vmLoginsPromptFor(botId: string, kind: ComputerPromptKind | null, agentsMounted: boolean, browserShown: boolean): string {
    if (!agentsMounted || browserShown || (kind !== "vm-private" && kind !== "vm-shared")) return "";
    return savedLoginsPrompt(botLogins.sitesFor(botId));
  }

  async function fillLoginOnVm(bot: BotRecord, capability: InternalCapability, rawUsername: unknown): Promise<{ ok: boolean; text: string }> {
    let vm: LocalVmTarget | undefined;
    try {
      vm = await attachmentVmForTurn(capability);
    } catch (error) {
      return { ok: false, text: `${error instanceof Error ? error.message : "The Local VM is not available to this turn."} Call request_sign_in if it keeps failing.` };
    }
    if (!vm) return { ok: false, text: "You have no Local VM desktop in this turn, so fill_login has nothing to fill. Call request_sign_in instead." };
    const runtime = (await containerRuntimeStatus()).runtime;
    if (!runtime) return { ok: false, text: "The Local VM's container runtime is not available. Call request_sign_in instead." };
    const target = vm;
    const stillAllowed = () => internalCapabilityIsActive({ ...capability, localVmTarget: target }) && !botComputerControlSnapshot(bot.id).held;
    if (!stillAllowed()) return { ok: false, text: "The Local VM is no longer available to this turn, or the person is using it. Call request_sign_in instead." };
    const username = typeof rawUsername === "string" ? rawUsername.slice(0, 512) : undefined;
    const page = vmLoginPage({ probe: firefoxProbe(runtime, target), input: cuaMcpInput(runtime, target), stillAllowed });
    try {
      const outcome = await fillLoginOn({
        username,
        candidates: (host) => botLogins.candidates(bot.id, host),
        available: async () => botLogins.sitesFor(bot.id),
      }, page, { remember: (value, kind) => heldSecrets.remember(value, kind) });
      touchLocalVm(target);
      if (outcome.ok && outcome.loginId) botLogins.markUsed(outcome.loginId);
      const problem = page.problem();
      if (problem) {
        const done = outcome.filled?.length ? ` Already filled: ${outcome.filled.join(" and ")}.` : "";
        return { ok: false, text: redactSecretsInText(`${problem}${done}`) };
      }
      return { ok: outcome.ok, text: outcome.text };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the login on the Local VM: ${redactSecretsInText(reason)} Call request_sign_in if it keeps failing.` };
    } finally {
      page.close();
    }
  }

  const FILL_LOGIN_ELSEWHERE: Record<Surface, string> = { browser: "your built-in browser", local: "this computer", vm: "the Local VM", cloud: "the cloud computer" };

  /** Filled by the server as one browser action; the answer is a status in words, never a value. */
  async function fillLoginForTurn(bot: BotRecord, capability: InternalCapability, rawUsername: unknown, rawSubmit: unknown): Promise<{ ok: boolean; text: string }> {
    const threadId = capability.threadId;
    const place = signInPlace(bot, threadId);
    if (place === "vm") return fillLoginOnVm(bot, capability, rawUsername);
    if (place !== "browser") {
      return { ok: false, text: place
        ? `fill_login works in the built-in browser, My Chrome and Firefox on a Local VM, not on ${FILL_LOGIN_ELSEWHERE[place]} yet. Call request_sign_in so the person signs in there.`
        : "fill_login works in the built-in browser, and this conversation has none. Call request_sign_in instead." };
    }
    const current = botForThread(bot.id, threadId) ?? bot;
    if (current.browser === false || current.computer === "off" || !builtInBrowserEnabled(cfg)) {
      return { ok: false, text: "The built-in browser is off for you here, so fill_login has nothing to fill. Call request_sign_in instead." };
    }
    const browser = await botBrowserTarget(current);
    if (!browser) return { ok: false, text: "The browser is not available on this computer right now. Call request_sign_in instead." };
    const { session, spec, env } = browser;
    if (!claimTurnResource(capability, `browser:${session}`)) {
      return { ok: false, text: "Another conversation is using this browser. Wait until it finishes, then call fill_login again." };
    }
    const username = typeof rawUsername === "string" ? rawUsername.slice(0, 512) : undefined;
    try {
      const outcome = await browserRuntime.withSecretInput(session, spec, () => fillLogin({
        username,
        submit: rawSubmit !== false,
        candidates: (host) => botLogins.candidates(bot.id, host),
        available: async () => botLogins.sitesFor(bot.id),
      }, {
        ...loginInput(session, spec, env),
        remember: (value, kind) => heldSecrets.remember(value, kind),
      }), stepContext(current, capability, () => liveTurnByThread.get(threadId) ?? null));
      if (outcome.ok && outcome.loginId) botLogins.markUsed(outcome.loginId);
      return { ok: outcome.ok, text: outcome.text };
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL) {
        return { ok: false, text: "The person is using this browser right now. Wait for them to hand it back, then call fill_login again." };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the login: ${redactSecretsInText(reason)} Call request_sign_in if it keeps failing.` };
    }
  }

  async function testCliBinary(
    cli: string,
    driver: (typeof BUILT_IN_DRIVERS)[number] | undefined,
  ): Promise<{ ok: boolean; version?: string; message?: string; install?: (typeof BUILT_IN_DRIVERS)[number]["install"] }> {
    return new Promise((resolve) => {
      execCli(
        cli,
        ["--version"],
        {
          timeout: 10_000,
          // SIGKILL, not SIGTERM: a child that traps TERM would never fire the callback and would pin the HTTP socket.
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 64,
          env: cliProbeEnvironment(),
        },
        (err, stdout) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            // Node's err.code is an errno string only for spawn failures; a non-zero exit gives the status, a timeout null with killed.
            const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            const isSpawnError = typeof e.code === "string" && !exceededBuffer;
            const message = exceededBuffer
              ? "CLI test produced more than 64 KiB of output"
              : isSpawnError
                ? describeSpawnFailure(e, cli).message
                : e.killed
                ? "CLI test timed out after 10s"
                : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
            resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
            return;
          }
          resolve({ ok: true, version: stdout.trim().split("\n")[0] });
        },
      );
    });
  }

  /** Only PATH: never hand inherited credentials to an arbitrary wrapper selected through Settings. */
  function cliProbeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
    stripWorkspaceCredentialEnv(env);
    for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
    return env;
  }

  function stderrOf(err: unknown): string {
    const s = (err as { stderr?: unknown }).stderr;
    return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
  }
  return { CONNECTOR_SLUG, attachmentNameInThread, messageFileRootsForThread, attachmentVmForTurn, connectorThread, lastHumanRoomMessageAt, roomPostEligibility, proposalPersistence, skillProposalPersistence, stagedSkillListing, stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages, applyOwnStagedSkill, appendSkillRequestCard, resolveSkillRequest, sendSkillResolution, connectorMessage, connectorCards, maybeResumeConnectors, phoneSecretSubmissions, claimPhoneSecretBotDeletion, phoneSecretSubmissionKey, credentialDesktopHandoff, secretMessage, currentSecretState, resumeSecretCard, provideSecretFromPhone, recordTurnPlace, requestSignIn, settleSignIn, signInSaveTarget, saveLoginFromCard, browserPromptFor, vmLoginsPromptFor, fillLoginForTurn, testCliBinary, cliProbeEnvironment };
}
