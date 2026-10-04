// "Agora" (lot Y), the screen's half: the server's status plus what the app
// already holds live (what waits on the person, the sessions to resume),
// turned into about six lines with numbers, each pointing where to act. Pure:
// the same inputs give the same lines, the same "novo" marks and the same
// Markdown. Unknown reads "—", never 0.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { awaitingBot, needsYouItems, waitingOnYou, type NeedsYouItem } from "@/lib/needs-you";
import type { Bot } from "@/state/store";
import { commitUrl, PR_ATTENTION, PRODUCTION_REPO_URL, type NowOpenPr, type NowPr, type NowSeen, type NowServerStatus } from "../../shared/now-status";

export type NowLineId = "production" | "release" | "prs" | "ci" | "needsYou" | "sessions" | "alerts" | "throughput";
export type NowTone = "ok" | "info" | "warn" | "danger" | "muted";
export type NowTarget =
  | { kind: "url"; url: string }
  | { kind: "thread"; botId: string; threadId: string }
  | { kind: "needsYou" }
  | { kind: "report" };

export interface NowLine {
  id: NowLineId;
  /** The line's name ("Produção"), its sentence, and a second line with the specifics. */
  label: string;
  text: string;
  detail?: string;
  tone: NowTone;
  /** Where a click goes; absent when there is nowhere better than the line itself. */
  target?: NowTarget;
  /** What the line says, reduced to its facts: a change of it is "novo". */
  fingerprint: string;
  /** The same line for "Copiar resumo", PRs linked. */
  markdown: string;
}

/** What the app holds live, reduced for the panel. */
export interface NowLocal {
  needsYou: { waiting: NeedsYouItem[]; awaitingBot: number };
  sessions: { resume: NowSessionRef[]; held: NowSessionRef[]; stuck: NowSessionRef[] };
}

export interface NowSessionRef { sessionId: string; title: string; botId: string; threadId: string; since: number }

export const DASH = "—";
const TZ = "America/Sao_Paulo";

export const shortSha = (sha: string): string => sha.slice(0, 9);

/** "08:30", in São Paulo (the report's calendar). */
export function clockText(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

/** "04/10 08:30". */
export function stampText(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms).replace(",", "");
}

/** "agora", "12 min", "1 h 20", "3 h", "2 d". */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return t("now.durationNow");
  if (minutes < 60) return t("now.durationMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return t("now.durationDays", { count: Math.floor(hours / 24) });
  const rest = minutes % 60;
  return rest ? t("now.durationHoursMinutes", { hours, minutes: String(rest).padStart(2, "0") }) : t("now.durationHours", { count: hours });
}

const num = (value: number | null | undefined): string => (value === null || value === undefined ? DASH : String(value));

/** The sessions to resume, on hold behind a release, and stalled — from the bots' rows. */
export function nowLocal(bots: readonly Bot[], now: number): NowLocal {
  const all = needsYouItems(bots);
  const sessions: NowLocal["sessions"] = { resume: [], held: [], stuck: [] };
  const seen = new Set<string>();
  for (const bot of bots) {
    if (bot.hidden) continue;
    for (const task of bot.tasks ?? []) {
      if (task.routineRunId || task.archivedAt) continue;
      for (const session of task.ccSessions ?? []) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        const ref = { sessionId: session.sessionId, title: session.title, botId: bot.id, threadId: task.threadId };
        if (session.resume) (session.resume.held ? sessions.held : sessions.resume).push({ ...ref, since: session.resume.since });
        else if (session.status === "stalled" || session.status === "failed") sessions.stuck.push({ ...ref, since: task.updatedAt ?? task.createdAt });
      }
    }
  }
  for (const list of Object.values(sessions)) list.sort((a, b) => a.since - b.since);
  return { needsYou: { waiting: waitingOnYou(all, now), awaitingBot: all.filter((item) => awaitingBot(item, now)).length }, sessions };
}

const PHASES = new Set(["queued", "build", "lint", "typecheck", "tests", "smart-deploy", "migration-lint", "migration-contracts", "schema-syntax", "script-contracts", "review", "deploy", "purge", "post-release", "tag"]);

/** The phase in the reader's words; a step the server does not know is said as the log names it. */
export function phaseText(phase: string | null | undefined): string {
  if (!phase) return DASH;
  return PHASES.has(phase) ? t(`now.phase.${phase}` as LocaleKey) : phase;
}

const prRef = (pr: Pick<NowPr, "number">): string => `#${pr.number}`;
const prMd = (pr: Pick<NowPr, "number" | "url">): string => `[#${pr.number}](${pr.url})`;
const titled = (pr: NowPr, max = 60): string => (pr.title ? `${prRef(pr)} ${pr.title.length > max ? `${pr.title.slice(0, max - 1)}…` : pr.title}` : prRef(pr));
const titledMd = (pr: NowPr): string => (pr.title ? `${prMd(pr)} ${pr.title}` : prMd(pr));

function productionLine(server: NowServerStatus | null, now: number): NowLine {
  const label = t("now.production.label");
  const production = server?.production;
  if (!server?.enabled || !production?.sha) {
    return { id: "production", label, text: t("now.production.unknown"), tone: "muted", fingerprint: "", markdown: `${label}: ${DASH}` };
  }
  const sha = shortSha(production.sha);
  const today = production.today;
  const prs = (today ?? []).flatMap((delivery) => delivery.prs ?? []);
  const unknownContents = (today ?? []).some((delivery) => delivery.prs === null);
  const since = production.at ? t("now.production.since", { age: durationText(now - production.at) }) : t("now.production.justNow");
  const todayText = today === null ? t("now.production.todayUnknown")
    : today.length === 0 ? t("now.production.todayNone")
      : today.length === 1 ? t("now.production.todayOne") : t("now.production.todayMany", { count: today.length });
  const tagOff = production.tag.agrees === false && production.tag.sha;
  const text = `${sha} · ${since} · ${todayText}`;
  const detailParts = [
    ...(prs.length ? [prs.slice(0, 3).map((pr) => titled(pr, 48)).join(" · ") + (prs.length > 3 ? ` ${t("now.more", { count: prs.length - 3 })}` : "")] : []),
    ...(unknownContents ? [t("now.production.contentsPending")] : []),
    ...(tagOff ? [t("now.production.tagOff", { sha: shortSha(production.tag.sha!), at: production.tag.checkedAt ? clockText(production.tag.checkedAt) : DASH })] : []),
  ];
  const newest = prs.at(0);
  return {
    id: "production", label, text,
    ...(detailParts.length ? { detail: detailParts.join(" · ") } : {}),
    tone: tagOff ? "warn" : today?.length ? "ok" : "info",
    target: { kind: "url", url: newest ? newest.url : commitUrl(production.sha) },
    fingerprint: [production.sha, ...(today ?? []).map((delivery) => delivery.sha)].join(","),
    markdown: `${label}: ${text}${prs.length ? ` — ${prs.map(titledMd).join("; ")}` : ""}${tagOff ? ` (${t("now.production.tagOff", { sha: shortSha(production.tag.sha!), at: production.tag.checkedAt ? clockText(production.tag.checkedAt) : DASH })})` : ""}`,
  };
}

function releaseLine(server: NowServerStatus | null, now: number): NowLine {
  const label = t("now.release.label");
  const release = server?.release;
  if (!server?.enabled || !release || release.state === "unknown") {
    return { id: "release", label, text: t("now.release.unknown"), tone: "muted", fingerprint: "unknown", markdown: `${label}: ${DASH}` };
  }
  const estimate = release.estimateMs !== null ? t("now.release.estimate", { estimate: durationText(release.estimateMs), samples: release.samples }) : t("now.release.noEstimate");
  if (release.state === "idle") {
    return { id: "release", label, text: t("now.release.idle"), detail: estimate, tone: "muted", fingerprint: "idle", markdown: `${label}: ${t("now.release.idle")}` };
  }
  const sha = release.sha ? shortSha(release.sha) : DASH;
  const elapsed = release.startedAt ? now - release.startedAt : null;
  let text: string;
  let tone: NowTone = "info";
  if (release.state === "queued") {
    text = t("now.release.queued", { sha, age: elapsed !== null ? durationText(elapsed) : DASH });
  } else {
    const phaseAge = release.phaseAt ? ` ${t("now.release.phaseFor", { age: durationText(now - release.phaseAt) })}` : "";
    text = t("now.release.running", { sha, phase: phaseText(release.phase), phaseAge, age: elapsed !== null ? durationText(elapsed) : DASH });
  }
  const parts: string[] = [];
  if (release.overdue) { tone = "danger"; parts.push(t("now.release.overdue")); }
  else if (elapsed !== null && release.estimateMs !== null && release.state === "running") {
    if (elapsed > release.estimateMs) { tone = "warn"; parts.push(t("now.release.over", { estimate: durationText(release.estimateMs) })); }
    else parts.push(t("now.release.left", { left: durationText(release.estimateMs - elapsed), estimate }));
  } else parts.push(estimate);
  const prs = release.prs;
  parts.push(prs === null || prs === undefined ? t("now.release.prsUnknown") : prs.length ? prs.slice(0, 3).map((pr) => titled(pr, 40)).join(" · ") + (prs.length > 3 ? ` ${t("now.more", { count: prs.length - 3 })}` : "") : t("now.release.prsNone"));
  const first = prs?.[0];
  return {
    id: "release", label, text, detail: parts.join(" · "), tone,
    ...(first ? { target: { kind: "url" as const, url: first.url } } : release.sha ? { target: { kind: "url" as const, url: commitUrl(release.sha) } } : {}),
    fingerprint: `${release.state}:${release.sha ?? ""}`,
    markdown: `${label}: ${text} — ${parts.slice(0, 1).join("")}${prs?.length ? `; ${prs.map(titledMd).join("; ")}` : ""}`,
  };
}

const gateText = (gate: NowOpenPr["gate"]): string => t(`now.gate.${gate}` as LocaleKey);
const mergeRank = (pr: NowOpenPr): number => {
  const at = (PR_ATTENTION as readonly string[]).indexOf(pr.merge);
  return at < 0 ? PR_ATTENTION.length : at;
};

function prsLine(server: NowServerStatus | null): NowLine {
  const label = t("now.prs.label");
  const prs = server?.prs;
  if (!server?.enabled || !prs || prs.list === null) {
    return { id: "prs", label, text: t("now.prs.unknown"), ...(prs?.error ? { detail: t("now.prs.error") } : {}), tone: "muted", fingerprint: "", markdown: `${label}: ${DASH}` };
  }
  const open = prs.list.filter((pr) => !pr.draft);
  const drafts = prs.list.length - open.length;
  const counts = PR_ATTENTION.map((state) => ({ state, count: open.filter((pr) => pr.merge === state).length })).filter((each) => each.count > 0);
  const receipts = open.filter((pr) => pr.gate === "success").length;
  const red = open.filter((pr) => pr.gate === "failure").length;
  const text = open.length === 0 ? t("now.prs.none")
    : [open.length === 1 ? t("now.prs.openOne") : t("now.prs.openMany", { count: open.length }),
      counts.map((each) => `${each.count} ${each.state}`).join(", "),
      t("now.prs.receipts", { count: receipts }),
      ...(red ? [t("now.prs.red", { count: red })] : [])].filter(Boolean).join(" · ");
  const ordered = open.toSorted((a, b) => mergeRank(a) - mergeRank(b) || a.number - b.number);
  const detail = [
    ...ordered.slice(0, 3).map((pr) => `${prRef(pr)} ${pr.merge}, ${gateText(pr.gate)}`),
    ...(ordered.length > 3 ? [t("now.more", { count: ordered.length - 3 })] : []),
    ...(drafts ? [drafts === 1 ? t("now.prs.draftOne") : t("now.prs.draftMany", { count: drafts })] : []),
    ...(prs.error ? [t("now.prs.stale", { at: prs.checkedAt ? clockText(prs.checkedAt) : DASH })] : []),
  ].join(" · ");
  const first = ordered[0];
  return {
    id: "prs", label, text, ...(detail ? { detail } : {}),
    tone: red || counts.some((each) => each.state === "DIRTY") ? "danger" : counts.length ? "warn" : open.length ? "info" : "ok",
    target: { kind: "url", url: first ? first.url : `${PRODUCTION_REPO_URL}/pulls` },
    fingerprint: open.map((pr) => `${pr.number}:${pr.merge}:${pr.gate}`).join(","),
    markdown: `${label}: ${text}${ordered.length ? ` — ${ordered.map((pr) => `${prMd(pr)} ${pr.merge}, ${gateText(pr.gate)}`).join("; ")}` : ""}`,
  };
}

function ciLine(server: NowServerStatus | null, now: number): NowLine {
  const label = t("now.ci.label");
  const ci = server?.ci;
  if (!server?.enabled || !ci || ci.state === "unknown") return { id: "ci", label, text: t("now.ci.unknown"), tone: "muted", fingerprint: "unknown", markdown: `${label}: ${DASH}` };
  const queued = ci.queued === null ? DASH : String(ci.queued);
  let text: string;
  let detail: string | undefined;
  let tone: NowTone = "info";
  if (ci.state === "running") {
    text = t("now.ci.running", { age: ci.since ? durationText(now - ci.since) : DASH, queued });
    const who = ci.session === "owner" ? t("now.ci.owner") : ci.session ? t("now.ci.session", { title: ci.session.title }) : t("now.ci.whoUnknown");
    detail = `${ci.label ?? DASH} · ${who}`;
  } else if (ci.state === "queued") {
    text = ci.behindRelease ? t("now.ci.queuedBehindRelease", { queued }) : t("now.ci.queued", { queued });
    tone = "warn";
    if (ci.behindRelease) { tone = "info"; detail = t("now.ci.legitimateWait"); }
  } else {
    text = t("now.ci.idle");
    tone = "muted";
  }
  const session = ci.session && ci.session !== "owner" ? ci.session : null;
  return {
    id: "ci", label, text, ...(detail ? { detail } : {}), tone,
    ...(session ? { target: { kind: "thread" as const, botId: session.botId, threadId: session.threadId } } : {}),
    fingerprint: `${ci.state}:${ci.label ?? ""}:${ci.queued ?? ""}`,
    markdown: `${label}: ${text}${detail ? ` (${detail})` : ""}`,
  };
}

function needsYouLine(local: NowLocal, now: number): NowLine {
  const label = t("now.needsYou.label");
  const waiting = local.needsYou.waiting;
  const oldest = waiting.reduce<number | null>((min, item) => (min === null || item.since < min ? item.since : min), null);
  const text = waiting.length === 0 ? t("now.needsYou.none")
    : `${waiting.length === 1 ? t("now.needsYou.one") : t("now.needsYou.many", { count: waiting.length })} · ${t("now.needsYou.oldest", { age: durationText(now - oldest!) })}`;
  const awaiting = local.needsYou.awaitingBot;
  const sorted = waiting.toSorted((a, b) => a.since - b.since);
  const detail = [
    ...sorted.slice(0, 2).map((item) => item.title.length > 56 ? `${item.title.slice(0, 55)}…` : item.title),
    ...(sorted.length > 2 ? [t("now.more", { count: sorted.length - 2 })] : []),
    ...(awaiting ? [awaiting === 1 ? t("now.needsYou.awaitingOne") : t("now.needsYou.awaitingMany", { count: awaiting })] : []),
  ].join(" · ");
  return {
    id: "needsYou", label, text, ...(detail ? { detail } : {}),
    tone: waiting.length ? "warn" : "ok",
    target: { kind: "needsYou" },
    fingerprint: sorted.map((item) => `${item.botId}:${item.threadId}:${item.pendingId ?? ""}`).join(","),
    markdown: `${label}: ${text}${sorted.length ? ` — ${sorted.map((item) => item.title).join("; ")}` : ""}`,
  };
}

function sessionsLine(local: NowLocal): NowLine | null {
  const { resume, held, stuck } = local.sessions;
  if (!resume.length && !held.length && !stuck.length) return null;
  const label = t("now.sessions.label");
  const parts = [
    ...(resume.length ? [resume.length === 1 ? t("now.sessions.resumeOne") : t("now.sessions.resumeMany", { count: resume.length })] : []),
    ...(stuck.length ? [stuck.length === 1 ? t("now.sessions.stuckOne") : t("now.sessions.stuckMany", { count: stuck.length })] : []),
    ...(held.length ? [t("now.sessions.held", { count: held.length })] : []),
  ];
  const first = resume[0] ?? stuck[0] ?? held[0]!;
  const titles = [...resume, ...stuck, ...held].map((session) => session.title);
  return {
    id: "sessions", label, text: parts.join(" · "),
    detail: titles.slice(0, 2).join(" · ") + (titles.length > 2 ? ` ${t("now.more", { count: titles.length - 2 })}` : ""),
    tone: resume.length || stuck.length ? "warn" : "info",
    target: { kind: "thread", botId: first.botId, threadId: first.threadId },
    fingerprint: [...resume, ...stuck, ...held].map((session) => session.sessionId).join(","),
    markdown: `${label}: ${parts.join(" · ")} — ${titles.join("; ")}`,
  };
}

function alertsLine(server: NowServerStatus | null, now: number): NowLine | null {
  const alerts = server?.alerts;
  if (!server?.enabled || !alerts?.length) return null;
  const label = t("now.alerts.label");
  const newest = alerts[0]!;
  const text = alerts.length === 1 ? newest.text : `${newest.text} ${t("now.more", { count: alerts.length - 1 })}`;
  return {
    id: "alerts", label, text,
    detail: t("now.alerts.when", { age: durationText(now - newest.at) }),
    tone: "danger",
    ...(newest.botId && newest.threadId ? { target: { kind: "thread" as const, botId: newest.botId, threadId: newest.threadId } } : {}),
    fingerprint: alerts.map((alert) => alert.key).join(","),
    markdown: `${label}: ${alerts.map((alert) => `${alert.text} (${clockText(alert.at)})`).join("; ")}`,
  };
}

function throughputLine(server: NowServerStatus | null): NowLine {
  const label = t("now.throughput.label");
  const day = server?.enabled ? server.throughput : null;
  const text = t("now.throughput.text", {
    deliveries: num(day?.deliveries), merged: num(day?.mergedPrs), closed: num(day?.closedIssues),
  });
  const failed = day?.failedReleases;
  const detail = [
    ...(failed ? [failed === 1 ? t("now.throughput.failedOne") : t("now.throughput.failedMany", { count: failed })] : []),
    day?.syncedAt ? t("now.throughput.synced", { at: clockText(day.syncedAt) }) : t("now.throughput.notSynced"),
  ].join(" · ");
  return {
    id: "throughput", label, text, detail, tone: "info", target: { kind: "report" },
    fingerprint: day ? [day.deliveries, day.mergedPrs, day.closedIssues].join(",") : "",
    markdown: `${label}: ${text}${failed ? ` · ${detail.split(" · ")[0]}` : ""}`,
  };
}

/** The panel's lines, in reading order: what is live, what moves, what waits, the day. */
export function nowLines(server: NowServerStatus | null, local: NowLocal, now: number): NowLine[] {
  return [
    productionLine(server, now),
    releaseLine(server, now),
    prsLine(server),
    ciLine(server, now),
    needsYouLine(local, now),
    sessionsLine(local),
    alertsLine(server, now),
    throughputLine(server),
  ].filter((line): line is NowLine => line !== null);
}

/** Lines whose facts changed since the owner last looked (none on the very first look). */
export function nowNews(lines: readonly NowLine[], seen: NowSeen | null): Set<NowLineId> {
  if (!seen) return new Set();
  return new Set(lines.filter((line) => line.fingerprint && seen.keys[line.id] !== line.fingerprint).map((line) => line.id));
}

export const seenKeys = (lines: readonly NowLine[]): Record<string, string> => Object.fromEntries(lines.map((line) => [line.id, line.fingerprint]));

/** "desde 08:30: +1 em produção, +2 esperando você" — what arrived since the owner last looked, counted from the facts' own times. */
export function nowSince(server: NowServerStatus | null, local: NowLocal, seen: NowSeen | null): string | null {
  if (!seen) return null;
  const after = (at: number | null | undefined) => at !== null && at !== undefined && at > seen.at;
  const parts: string[] = [];
  const delivered = (server?.production.today ?? []).filter((delivery) => after(delivery.at)).length;
  if (delivered) parts.push(t("now.since.production", { count: delivered }));
  const waiting = local.needsYou.waiting.filter((item) => after(item.since)).length;
  if (waiting) parts.push(t("now.since.needsYou", { count: waiting }));
  const opened = (server?.prs.list ?? []).filter((pr) => !pr.draft && after(pr.createdAt)).length;
  if (opened) parts.push(t("now.since.prs", { count: opened }));
  const resume = local.sessions.resume.filter((session) => after(session.since)).length;
  if (resume) parts.push(t("now.since.sessions", { count: resume }));
  const alerts = (server?.alerts ?? []).filter((alert) => after(alert.at)).length;
  if (alerts) parts.push(t("now.since.alerts", { count: alerts }));
  return parts.length ? t("now.since.some", { at: clockText(seen.at), changes: parts.join(", ") }) : t("now.since.none", { at: clockText(seen.at) });
}

/** "Copiar resumo": the same lines in Markdown, as an update to the owner reads. */
export function nowMarkdown(lines: readonly NowLine[], now: number, since: string | null): string {
  return [`**${t("now.markdownTitle", { at: stampText(now) })}**`, ...(since ? [`_${since}_`] : []), "", ...lines.map((line) => `- ${line.markdown}`)].join("\n");
}

/** What deserves a discreet macOS notification: a delivery that just reached
 * production, an item that just started waiting on the owner — each once
 * (`sent` is the dedupe record, kept by the caller). */
export function nowNotifications(server: NowServerStatus | null, local: NowLocal, sent: ReadonlySet<string>): Array<{ key: string; title: string; body: string; target: NowTarget }> {
  const out: Array<{ key: string; title: string; body: string; target: NowTarget }> = [];
  for (const delivery of server?.production.today ?? []) {
    const key = `production:${delivery.sha}`;
    if (sent.has(key)) continue;
    const prs = delivery.prs ?? [];
    out.push({ key, title: t("now.notify.production", { sha: shortSha(delivery.sha) }), body: prs.length ? prs.map((pr) => titled(pr, 60)).join(" · ") : t("now.production.contentsPending"), target: { kind: "url", url: prs[0]?.url ?? commitUrl(delivery.sha) } });
  }
  for (const item of local.needsYou.waiting) {
    const key = `needsYou:${item.botId}:${item.threadId}:${item.pendingId ?? ""}`;
    if (sent.has(key)) continue;
    out.push({ key, title: t("now.notify.needsYou", { name: item.botName }), body: item.title, target: { kind: "needsYou" } });
  }
  return out;
}

/** Every key nowNotifications could raise now: the first look seeds the record with them (no burst of old news). */
export function nowNotificationKeys(server: NowServerStatus | null, local: NowLocal): string[] {
  return nowNotifications(server, local, new Set()).map((each) => each.key);
}
