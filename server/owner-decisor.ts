// The Decisor: the owner's proxy for "Precisa de você". The owner asked that
// every item of the panel be decided for him, with lenient rules he can
// tighten later; this module is that, inside the server — not a bot (a bot
// would need its own VM, and its shell is exactly what the local API's
// "this change must come from the desktop app" guard keeps out).
//
// The rules (decisor-policy.json in the data dir, re-read on every pass):
// - off unless the file exists with "enabled" not false; "mode": "dry-run"
//   logs what it would do and does nothing;
// - a decision goes through the SAME route the panel's buttons use
//   (POST /api/bots/:id/owner-pending/:item/reply, called in-process), so the
//   disk checks, the spend cap, the answer dedupe, the queue and the
//   superseded mark all still apply; the bot reads it marked as the Decisor's;
// - the option marked RECOMENDADA, else the most conservative one that is
//   not a hard stop — never one that says the owner did something ("Já
//   resolvi", "Liberei"); merge, SHA approval and the app swap go through the
//   policy like anything else; an item without options (or whose only options
//   claim an owner action) gets the policy's go-ahead text;
// - "Só você" (owner-delegate.ts's categories) is NOT a stop here: only the
//   hard stops are — irreversible deletion/alteration of production data,
//   real money, messages to people outside, credentials, disabling a
//   security control. Those items stay for the owner;
// - an item that needs the owner's body (archive by hand, plug the Mac in,
//   a gesture in an app) is handed back to its bot once, then closed with a
//   note; the server's own such items are closed with a note at once;
// - never twice on the same version of an item; at most a few per pass; a
//   decision its bot never followed up is closed with a note (stale);
// - ~/.nuria/stop holds it like every other sender.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

import { OWNER_PENDING_AWAIT_MS, type OwnerPending, type OwnerPendingOption, type ResolvedOwnerPending } from "./bot-autonomy.ts";
import { readings } from "./owner-delegate.ts";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export const DECISOR_POLICY_FILE = "decisor-policy.json";
export const DECISOR_LOG_FILE = "decisor-log.jsonl";
/** How often the server looks at the panel, and how long after boot it first does. */
export const DECISOR_TICK_MS = 60_000;
export const DECISOR_BOOT_DELAY_MS = 2 * 60_000;
/** A failed answer is tried again after this, at most DECISOR_MAX_FAILURES times per version. */
export const DECISOR_RETRY_MS = 15 * 60_000;
export const DECISOR_MAX_FAILURES = 3;
/** A server item it closed and the server opened again: left to the owner for this long. */
export const DECISOR_REOPEN_HOLD_MS = 24 * 3_600_000;
/** What the bot reads on top of the Decisor's answer (the route adds it). */
export const DECISOR_LINE = "[Decidido pelo Decisor do OpenMausBot, em nome do dono, pela política em decisor-policy.json]";
/** The note an item the Decisor closed keeps in the audit ("resolvido por ..."). */
export const DECISOR_NOTE_PREFIX = "Decisor:";

// ── the policy ──────────────────────────────────────────────────────────

export interface HardStop {
  id: string;
  /** What the owner and the log read ("fica com você: <label>"). */
  label: string;
  /** Regex sources (case-insensitive, on the text lowercased, no accents): the rule matches when any matches… */
  anyOf?: string[];
  /** …and every one of these matches (co-occurrence anywhere in the text). */
  allOf?: string[];
}

export interface DecisorPolicy {
  enabled: boolean;
  mode: "on" | "dry-run";
  /** An item (or its last rewrite) must be this old before it is decided: the bot may still be writing it. */
  graceMinutes: number;
  maxPerTick: number;
  /** Decisions per item (across rewrites) before it is left to the owner. */
  maxDecisionsPerItem: number;
  /** No RECOMENDADA: the most conservative non-stop option, the first non-stop one, or leave it. */
  noRecommended: "conservative" | "first" | "keep";
  /** No options at all: answer with `noOptionsReply`, or leave it. */
  noOptions: "reply" | "keep";
  /** `{hardStops}` is replaced by the list of what still needs the owner. */
  noOptionsReply: string;
  /** Needs the owner's body: hand it to its bot once then close it, close it at once, or leave it. */
  physical: "delegate-then-resolve" | "resolve" | "keep";
  /** Decided, and its bot let it go back to the owner without acting: close with a note, or leave it. */
  stale: "resolve" | "keep";
  /** Bots the Decisor never answers for (ids). */
  skipBots: string[];
  /** Replaces the default hard stops when given. */
  hardStops: HardStop[];
}

export const DEFAULT_HARD_STOPS: HardStop[] = [
  {
    id: "dados-producao",
    label: "apagar ou alterar dados de produção (irreversível)",
    // the verb and production in the same sentence, in either order; or an authorization to act in production
    anyOf: [
      "\\b(?:apag|delet|exclu|remov|drop|truncat|purg|wipe|sobrescrev|overwrit|alter|escrit|escrev|migr|restaur)\\w*[^.\\n]{0,60}\\b(?:producao|production|prod|banco de dados|database|dados (?:de|dos) clientes|dados clinicos|backups?)\\b",
      "\\b(?:producao|production|prod|banco de dados|database|backups?)\\b[^.\\n]{0,60}\\b(?:apag|delet|exclu|remov|drop|truncat|purg|wipe|sobrescrev|overwrit|alter|escrit|escrev|migr)",
      "\\bautoriz\\w*[^.\\n]{0,40}\\b(?:em|na|de|da) producao\\b",
    ],
  },
  {
    id: "dados-sql-destrutivo",
    label: "comando que destrói dados (DROP, TRUNCATE, DELETE FROM, rm -rf /)",
    anyOf: ["\\bdrop (?:table|database|schema)\\b", "\\btruncate\\b", "\\bdelete from\\b", "\\brm -rf /(?!tmp\\b)"],
  },
  {
    id: "dinheiro",
    label: "gastar dinheiro de verdade (compra, pagamento, plano, créditos)",
    anyOf: [
      "\\b(?:compr(?:ar|e|a|ou|ando)|pag(?:ar|ue|uei|amentos?)|upgrade de plano|plano pago|cartao de credito|faturas?|cobrancas?|invoices?|billing|purchase|buy|checkout|top[- ]?up|recarg(?:a|ar))\\b",
      "(?:r\\$|us\\$|usd|brl|€)\\s?\\d",
      "\\b\\d+(?:[.,]\\d+)?\\s?(?:reais|dolares|dollars|euros)\\b",
      "\\bcreditos? (?:da|de|na|no) (?:api|conta|openai|anthropic|openrouter|cloud)",
    ],
  },
  {
    id: "mensagem-externa",
    label: "mandar mensagem para gente de fora (cliente, e-mail, WhatsApp, redes)",
    anyOf: [
      "\\b(?:envi|mand|respond|notific|avis(?:ar|e|ando)\\b|escrev|contat|post(?:ar|e)\\b|public(?:ar|ue|a)\\b|dispar|comunic(?:ar|ue)\\b|ligar para)[^.\\n]{0,80}\\b(?:clientes?|customers?|usuarios? finais|solicitantes?|pacientes?|fornecedor|parceir|imprensa|extern|e-?mails?|gmail|whatsapp|sms|telegram|linkedin|instagram|twitter|redes sociais)",
    ],
  },
  {
    id: "credenciais",
    label: "expor ou mexer em senha, token ou credencial",
    anyOf: [
      "\\b(?:senhas?|passwords?|tokens? de (?:acesso|api)|access tokens?|credenciai?s?|credentials?|secrets?|segredos?|api[_ -]?keys?|chaves? (?:de api|privadas?|secretas?|ssh)|private keys?|keychain|chaveiro)\\b",
      "(?:^|[^\\w-])\\.env\\b", "\\.ssh\\b", "\\bid_(?:rsa|ed25519)\\b", "\\.npmrc\\b|\\.netrc\\b",
    ],
  },
  {
    id: "seguranca",
    label: "desligar ou contornar um controle de segurança (hook, revisor, 2FA, proteção)",
    anyOf: [
      "\\b(?:desativ|deslig|desabilit|disabl|bypass|contorn|burl|skip|afrouxa|relax|turn off)[^.\\n]{0,60}\\b(?:seguranca|security|hooks?|revisor|review|2fa|mfa|firewall|antivirus|sandbox|guard|protec|rulesets?|codeowners|scanners?|dependabot|autentica|auth|gates?|verificac|classificador)",
      "--no-verify", "--admin\\b", "\\bchmod 777\\b", "\\bsudo\\b",
    ],
  },
];

export const DEFAULT_NO_OPTIONS_REPLY = [
  "Pode seguir com este item.",
  "Faça você mesmo o que ele pede, pelos caminhos que já tem (sua VM, suas ferramentas, ou pedindo ao Chief of Staff ou a outro bot que tenha o acesso), escolhendo o caminho mais conservador que faça o trabalho andar.",
  "Se algum passo só puder ser feito pelo Osvaldo em pessoa, registre isso, siga com o resto e feche ou reescreva a pendência — não espere por ele.",
  "Continua exigindo o Osvaldo: {hardStops}.",
].join(" ");

export const DEFAULT_DECISOR_POLICY: DecisorPolicy = {
  enabled: true,
  mode: "on",
  graceMinutes: 3,
  maxPerTick: 3,
  maxDecisionsPerItem: 3,
  noRecommended: "conservative",
  noOptions: "reply",
  noOptionsReply: DEFAULT_NO_OPTIONS_REPLY,
  physical: "delegate-then-resolve",
  stale: "resolve",
  skipBots: [],
  hardStops: DEFAULT_HARD_STOPS,
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const count = (value: unknown, fallback: number, min: number, max: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

function hardStopsOf(value: unknown): HardStop[] | string {
  if (!Array.isArray(value)) return "hardStops must be a list";
  const out: HardStop[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return `hardStops[${index}] must be an object`;
    const rule = raw as Record<string, unknown>;
    const sources = (field: "anyOf" | "allOf") => (Array.isArray(rule[field]) ? (rule[field] as unknown[]).filter((each): each is string => typeof each === "string" && each.trim() !== "") : []);
    const anyOf = sources("anyOf");
    const allOf = sources("allOf");
    if (!anyOf.length && !allOf.length) return `hardStops[${index}] needs anyOf or allOf`;
    for (const source of [...anyOf, ...allOf]) {
      try {
        new RegExp(source, "iu");
      } catch (error) {
        return `hardStops[${index}]: invalid pattern ${JSON.stringify(source)} (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    const id = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `regra-${index + 1}`;
    out.push({ id, label: typeof rule.label === "string" && rule.label.trim() ? rule.label.trim() : id, ...(anyOf.length ? { anyOf } : {}), ...(allOf.length ? { allOf } : {}) });
  }
  return out;
}

/** The policy as the owner wrote it, over the defaults; an error when the file
 * cannot be read as one (the Decisor then does nothing: fail closed). */
export function parseDecisorPolicy(raw: unknown): { policy: DecisorPolicy } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the policy must be a JSON object" };
  const input = raw as Record<string, unknown>;
  let hardStops = DEFAULT_HARD_STOPS;
  if (input.hardStops !== undefined) {
    const parsed = hardStopsOf(input.hardStops);
    if (typeof parsed === "string") return { error: parsed };
    hardStops = parsed;
  }
  if (input.extraHardStops !== undefined) {
    const extra = hardStopsOf(input.extraHardStops);
    if (typeof extra === "string") return { error: extra.replace(/^hardStops/, "extraHardStops") };
    hardStops = [...hardStops, ...extra];
  }
  const d = DEFAULT_DECISOR_POLICY;
  return {
    policy: {
      enabled: input.enabled !== false,
      mode: oneOf(input.mode, ["on", "dry-run"] as const, d.mode),
      graceMinutes: count(input.graceMinutes, d.graceMinutes, 0, 24 * 60),
      maxPerTick: count(input.maxPerTick, d.maxPerTick, 1, 50),
      maxDecisionsPerItem: count(input.maxDecisionsPerItem, d.maxDecisionsPerItem, 1, 20),
      noRecommended: oneOf(input.noRecommended, ["conservative", "first", "keep"] as const, d.noRecommended),
      noOptions: oneOf(input.noOptions, ["reply", "keep"] as const, d.noOptions),
      noOptionsReply: typeof input.noOptionsReply === "string" && input.noOptionsReply.trim() ? input.noOptionsReply.trim().slice(0, 1_500) : d.noOptionsReply,
      physical: oneOf(input.physical, ["delegate-then-resolve", "resolve", "keep"] as const, d.physical),
      stale: oneOf(input.stale, ["resolve", "keep"] as const, d.stale),
      skipBots: Array.isArray(input.skipBots) ? input.skipBots.filter((each): each is string => typeof each === "string") : [],
      hardStops,
    },
  };
}

/** Reads the policy file: null when it does not exist (the Decisor is off). Cached by mtime. */
export function createPolicyReader(path: string): () => { policy: DecisorPolicy } | { error: string } | null {
  let cache: { mtimeMs: number; size: number; value: { policy: DecisorPolicy } | { error: string } } | null = null;
  return () => {
    if (!existsSync(path)) return null;
    try {
      const stat = statSync(path);
      if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;
      let value: { policy: DecisorPolicy } | { error: string };
      try {
        value = parseDecisorPolicy(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        value = { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
      }
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
      return value;
    } catch (error) {
      return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

// ── what an item asks ───────────────────────────────────────────────────

/** The first hard stop the text falls in, or null. */
export function hardStopHit(text: string, stops: readonly HardStop[]): HardStop | null {
  const forms = readings(text);
  const test = (source: string) => {
    const pattern = new RegExp(source, "iu");
    return forms.some((form) => pattern.test(form));
  };
  for (const stop of stops) {
    const any = !stop.anyOf?.length || stop.anyOf.some(test);
    const all = !stop.allOf?.length || stop.allOf.every(test);
    if (any && all) return stop;
  }
  return null;
}

/** The server's own items that need the owner's body (keyed by the server). */
export const PHYSICAL_KEY_PREFIXES = ["cc-archive:", "cc-rename:", "app-reused-folder:", "own-worktree-breaker:", "power:"];
/** A bot's item whose steps need the owner's body: "à mão", "no Mac", the app's Settings, the plug. */
const PHYSICAL_WORDS = /\ba mao\b|\bmanual(?:mente)?\b|\bno mac\b|\bapp settings\b|\bconfiguracoes do (?:app|openmausbot)\b|\bno app (?:claude|openmausbot)\b|\bno openmausbot\b|\bna tomada\b|\bfisicamente\b|\bpresencial(?:mente)?\b|\bpessoalmente\b/;
/** Words of an option that destroys (worst) or only defers (better): the conservative pick avoids both, destroying first. */
const DESTRUCTIVE = /\b(?:remov|apag|delet|exclu|descart|limpar|limpe|forc|force|reset|revert|derrub|encerr|cancel|arquiv)/;
const DEFERRING = /\b(?:mant(?:er|enha|em)|aguard|esper|depois|adi(?:ar|e)|nao (?:fazer|mexer|agora)|deixar? como|retir(?:ar|e) da fila|pausar?|ignor)/;

const has = (pattern: RegExp, text: string) => readings(text).some((form) => pattern.test(form));

export function physicalItem(item: Pick<OwnerPending, "title" | "steps" | "key">): "server" | "bot" | null {
  if (item.key && PHYSICAL_KEY_PREFIXES.some((prefix) => item.key!.startsWith(prefix))) return "server";
  if (item.key) return null;
  return has(PHYSICAL_WORDS, [item.title, ...(item.steps ?? []).map((step) => step.text)].join("\n")) ? "bot" : null;
}

/** An option that says the OWNER did something ("Já resolvi", "Liberei",
 * "Já fiz", "Feito", "Concluí", "Ajustei o hook"): only the owner can say that;
 * the Decisor answering it tells the bot a fact that is false. */
const CLAIM_LABEL = [
  // first person, past: "Liberei", "Ajustei o hook", "Já resolvi", "Eu já conferi" (and -i verbs: resolvi, conclui, corrigi, fiz, fiz isso)
  /^(?:eu\s+)?(?:ja\s+)?(?:\p{L}{2,}ei|resolvi|conclui|corrigi|conferi|permiti|decidi|inclui|removi|mexi|atendi|cumpri|fiz|fizemos|terminei|instalei|conectei|reconectei|subi|abri|respondi|vi|li|bati)\b/u,
  /^(?:ja\s+)?(?:feito|pronto|concluido|resolvido|ok,? feito|tudo certo|liberado|liberada|ajustado|ajustada|aprovado|aprovada)\b/u,
];
const CLAIM_ANYWHERE = /\bja (?:resolvi|fiz|liberei|conclui|corrigi|ajustei|aprovei|tratei|terminei|fiz isso)\b|\b(?:ja )?(?:esta|foi|ficou) (?:feito|resolvido|concluido|liberado|ajustado|corrigido)\b|\b(?:eu|o dono|osvaldo) (?:ja )?(?:resolvi|resolveu|fiz|fez|liberei|liberou|conclui|concluiu)\b/u;

/** The option claims an owner action (case and accent insensitive). */
export function claimsOwnerAction(option: Pick<OwnerPendingOption, "label" | "reply">): boolean {
  const label = readings(option.label).map((form) => form.trim());
  if (label.some((form) => CLAIM_LABEL.some((pattern) => pattern.test(form)) || CLAIM_ANYWHERE.test(form))) return true;
  return readings(option.reply).some((form) => CLAIM_ANYWHERE.test(form.trim()) || CLAIM_LABEL.some((pattern) => pattern.test(form.trim())));
}

/** The Decisor's pick among an item's options, or why none. Never an option
 * that claims the owner did something. Merge, SHA approval and the app swap
 * go through the policy like any other subject (owner's call, 20/10). */
export function chooseOption(item: Pick<OwnerPending, "title" | "options"> & { why?: string }, policy: Pick<DecisorPolicy, "noRecommended" | "hardStops">): { index: number; option: OwnerPendingOption; why: string } | { keep: string } {
  const options = item.options ?? [];
  const stops = policy.hardStops;
  const stopOf = (option: OwnerPendingOption) => hardStopHit([item.title, option.label, option.reply].join("\n"), stops);
  const recommended = options.findIndex((option) => option.recommended);
  const recommendedClaims = recommended >= 0 && claimsOwnerAction(options[recommended]!);
  if (recommended >= 0 && !recommendedClaims) {
    const option = options[recommended]!;
    const stop = stopOf(option);
    // the bot's own pick is a hard stop: never overridden by another option, it is the owner's
    if (stop) return { keep: `a decisão recomendada cai num limite: ${stop.label}` };
    return { index: recommended, option, why: "a recomendada pelo bot" };
  }
  // the recommended (or every) option may say the owner did something: only the others are the Decisor's to pick
  const real = options.map((option, index) => ({ option, index })).filter(({ option }) => !claimsOwnerAction(option));
  if (!real.length) return { keep: "só há decisões que afirmam algo que o dono fez (\"Já resolvi\", \"Liberei\"…): fica com você" };
  if (policy.noRecommended === "keep") return { keep: recommendedClaims ? "a recomendada afirma algo que o dono fez (a política deixa com você)" : "nenhuma decisão recomendada (a política deixa com você)" };
  const safe = real.filter(({ option }) => !stopOf(option));
  if (!safe.length) return { keep: `todas as decisões caem num limite: ${stopOf(real[0]!.option)?.label ?? "?"}` };
  const lead = recommendedClaims ? "a recomendada afirma algo que o dono fez" : "nenhuma recomendada";
  if (policy.noRecommended === "first") return { ...safe[0]!, why: `${lead}: a primeira fora dos limites` };
  // the label says what the option is ("Manter por 7 dias" may still say "não as remova" in its reply); the reply only when the label says neither
  const kind = (text: string) => (has(DEFERRING, text) ? 1 : has(DESTRUCTIVE, text) ? 2 : null);
  const rank = (option: OwnerPendingOption) => kind(option.label) ?? kind(option.reply) ?? 0;
  const best = safe.reduce((a, b) => (rank(b.option) < rank(a.option) ? b : a));
  return { ...best, why: `${lead}: a mais conservadora que faz andar` };
}

// ── the plan for one item ───────────────────────────────────────────────

export type DecisorPlan =
  | { action: "option"; index: number; label: string; why: string }
  | { action: "text"; text: string; why: string }
  | { action: "resolve"; note: string; why: string }
  | { action: "keep"; why: string }
  | { action: "wait"; why: string };

export interface PlanContext {
  policy: DecisorPolicy;
  now: number;
  /** The item's conversation still exists. */
  threadExists: boolean;
  /** The Decisor closed an item with this key within DECISOR_REOPEN_HOLD_MS (the server opened it again). */
  closedKeyRecently: boolean;
}

/** The version an answer is about: the item's last rewrite, else its creation. */
export const itemVersion = (item: Pick<OwnerPending, "createdAt" | "updatedAt">) => Math.max(item.createdAt, item.updatedAt ?? 0);

/** What the Decisor does with one open item now. Pure: the pass executes it. */
export function planDecision(item: OwnerPending, ctx: PlanContext): DecisorPlan {
  const { policy, now } = ctx;
  if (policy.skipBots.includes(item.botId)) return { action: "keep", why: "bot fora da política (skipBots)" };
  if (item.delegation) return { action: "wait", why: "delegado a um agente" };
  const version = itemVersion(item);
  if (now - version < policy.graceMinutes * 60_000) return { action: "wait", why: "item novo ou reescrito há pouco" };
  if ((item.stepsRequestedAt ?? 0) > version || (item.recommendRequestedAt ?? 0) > version) return { action: "wait", why: "o bot está reescrevendo o item" };
  const history = item.history ?? [];
  const lastSent = history.findLast((entry) => entry.delivered || entry.queued);
  if (lastSent?.queued) return { action: "wait", why: "uma resposta ainda está na fila da conversa" };
  if (item.awaitingSince !== undefined && now - item.awaitingSince < OWNER_PENDING_AWAIT_MS) return { action: "wait", why: "aguardando o bot responder" };
  const mine = history.filter((entry) => entry.decisor && (entry.delivered || entry.queued));
  const decidedThisVersion = mine.some((entry) => entry.at >= version);
  if (decidedThisVersion) {
    return policy.stale === "resolve"
      ? { action: "resolve", note: `${DECISOR_NOTE_PREFIX} decidido e o bot não deu retorno em ${Math.round(OWNER_PENDING_AWAIT_MS / 3_600_000)} h; fechado`, why: "decisão sem retorno do bot" }
      : { action: "keep", why: "decisão sem retorno do bot (a política deixa com você)" };
  }
  if (!ctx.threadExists) return { action: "resolve", note: `${DECISOR_NOTE_PREFIX} a conversa de origem não existe mais`, why: "conversa de origem apagada" };
  if (item.supersededBy) return { action: "resolve", note: `${DECISOR_NOTE_PREFIX} substituído por ${item.supersededBy.id} de ${item.supersededBy.botName}`, why: "item substituído" };
  if (item.demotedAt !== undefined) return { action: "resolve", note: `${DECISOR_NOTE_PREFIX} estava em "Talvez já resolvido"`, why: "talvez já resolvido" };
  if (mine.length >= policy.maxDecisionsPerItem) return { action: "keep", why: `já decidido ${mine.length} vezes neste item` };
  const physical = physicalItem(item);
  if (physical === "server") {
    if (ctx.closedKeyRecently) return { action: "keep", why: "o servidor reabriu um item que o Decisor fechou (precisa de você em pessoa)" };
    if (policy.physical === "keep") return { action: "keep", why: "precisa de você em pessoa (a política deixa com você)" };
    return { action: "resolve", note: `${DECISOR_NOTE_PREFIX} precisa de um gesto do dono no Mac ou num app; nenhum agente pode fazê-lo — fechado com esta nota`, why: "gesto físico do dono" };
  }
  // options that only claim the owner did something ("Já resolvi") are no options for the Decisor: the item is answered like one without any
  if (item.options?.length && item.options.some((option) => !claimsOwnerAction(option))) {
    const choice = chooseOption(item, policy);
    if ("keep" in choice) return { action: "keep", why: choice.keep };
    return { action: "option", index: choice.index, label: choice.option.label, why: choice.why };
  }
  const stop = hardStopHit([item.title, item.why ?? "", ...(item.steps ?? []).flatMap((step) => [step.text, step.command ?? ""]), item.command ?? ""].join("\n"), policy.hardStops);
  if (stop) return { action: "keep", why: `cai num limite: ${stop.label}` };
  if (physical === "bot" && policy.physical !== "delegate-then-resolve") {
    return policy.physical === "keep"
      ? { action: "keep", why: "precisa de você em pessoa (a política deixa com você)" }
      : { action: "resolve", note: `${DECISOR_NOTE_PREFIX} precisa de um gesto do dono; fechado com esta nota`, why: "gesto físico do dono" };
  }
  // handed back to its bot once; if it comes back still needing the owner's body, closed with a note
  if (physical === "bot" && mine.length) return { action: "resolve", note: `${DECISOR_NOTE_PREFIX} o bot não conseguiu fazer sem o dono em pessoa; fechado com esta nota`, why: "gesto físico do dono, já devolvido ao bot" };
  if (policy.noOptions === "keep") return { action: "keep", why: "sem decisões para escolher (a política deixa com você)" };
  return { action: "text", text: noOptionsText(policy), why: physical === "bot" ? "precisa de gesto físico: devolvido ao bot uma vez" : "sem decisões: autorizado a seguir" };
}

export function noOptionsText(policy: Pick<DecisorPolicy, "noOptionsReply" | "hardStops">): string {
  return policy.noOptionsReply.replace("{hardStops}", policy.hardStops.map((stop) => stop.label).join("; "));
}

// ── the pass ────────────────────────────────────────────────────────────

/** What the route answered (status and body), when the Decisor calls it in-process. */
export interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** Requests the Decisor makes: the reply route marks their answers as the Decisor's. No HTTP request can be one. */
const decisorRequests = new WeakSet<object>();
export const isDecisorRequest = (req: object) => decisorRequests.has(req);

/** The owner's own scopes, as a loopback request from the desktop app has them. */
const DECISOR_AUTH: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

/** Runs one route of the table in-process, as the panel's button would, and returns what it answered. */
export async function invokeRoute(handler: RouteHandler, path: string, body: Record<string, unknown>): Promise<RouteAnswer> {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: path, headers: {} as Record<string, string> }) as unknown as IncomingMessage;
  decisorRequests.add(req);
  const answer: RouteAnswer = { status: 0, body: {} };
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader() { return res; },
    writeHead(status: number) {
      answer.status = status;
      res.headersSent = true;
      return res;
    },
    end() {
      res.writableEnded = true;
      return res;
    },
  };
  const out = await handler({
    req,
    res: res as unknown as ServerResponse,
    url: new URL(path, "http://127.0.0.1"),
    path,
    method: "POST",
    auth: DECISOR_AUTH,
    json: ((target: ServerResponse, status: number, data: unknown) => {
      answer.body = data && typeof data === "object" ? (data as Record<string, unknown>) : { value: data };
      target.writeHead(status);
      target.end();
    }) as never,
    readBody: (async () => body) as never,
  });
  if (out === PASS && !answer.status) return { status: 404, body: { error: "no route answered" } };
  return answer;
}

export interface DecisorLogEntry {
  at: string;
  botId: string;
  bot: string;
  item: string;
  title: string;
  action: DecisorPlan["action"];
  why: string;
  option?: string;
  note?: string;
  status?: number;
  error?: string;
  dryRun?: true;
}

export interface DecisorDeps {
  readPolicy(): { policy: DecisorPolicy } | { error: string } | null;
  openItems(): OwnerPending[];
  resolvedItems(): ResolvedOwnerPending[];
  threadExists(botId: string, threadId: string): boolean;
  botName(botId: string): string;
  /** ~/.nuria/stop: nothing goes out to the bots. */
  stopped(): boolean;
  /** POST /api/bots/:bot/owner-pending/:item/reply, in-process. */
  reply(botId: string, itemId: string, body: Record<string, unknown>): Promise<RouteAnswer>;
  /** Close the item for the owner, with the note (chip in its conversation, the bot's row refreshed). */
  resolve(item: OwnerPending, note: string): void;
  log(line: string): void;
  /** One JSON line per thing done (decisor-log.jsonl). */
  audit(entry: DecisorLogEntry): void;
  now(): number;
}

export interface Decisor {
  tick(): Promise<DecisorLogEntry[]>;
}

export function createDecisor(deps: DecisorDeps): Decisor {
  const failures = new Map<string, { count: number; at: number }>();
  /** What was last logged per item, so a kept or waiting item is said once per version, not every minute. */
  const said = new Map<string, string>();
  let lastPolicyError = "";
  let running = false;

  const entryOf = (item: OwnerPending, plan: DecisorPlan, extra: Partial<DecisorLogEntry> = {}): DecisorLogEntry => ({
    at: new Date(deps.now()).toISOString(), botId: item.botId, bot: deps.botName(item.botId), item: item.id, title: item.title.slice(0, 200),
    action: plan.action, why: plan.why,
    ...(plan.action === "option" ? { option: plan.label } : {}), ...(plan.action === "resolve" ? { note: plan.note } : {}), ...extra,
  });

  async function pass(): Promise<DecisorLogEntry[]> {
    const read = deps.readPolicy();
    if (!read) return [];
    if ("error" in read) {
      if (read.error !== lastPolicyError) deps.log(`policy not applied, nothing decided: ${read.error}`);
      lastPolicyError = read.error;
      return [];
    }
    lastPolicyError = "";
    const { policy } = read;
    if (!policy.enabled) return [];
    if (deps.stopped()) return [];
    const now = deps.now();
    // One pass over the resolved history per tick, not one per open item.
    const recentlyClosedKeys = new Set<string>();
    for (const each of deps.resolvedItems()) {
      if (each.key && each.resolvedNote?.startsWith(DECISOR_NOTE_PREFIX) && now - each.resolvedAt < DECISOR_REOPEN_HOLD_MS) recentlyClosedKeys.add(each.key);
    }
    const done: DecisorLogEntry[] = [];
    let acted = 0;
    for (const item of [...deps.openItems()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (acted >= policy.maxPerTick) break;
      const closedKeyRecently = Boolean(item.key && recentlyClosedKeys.has(item.key));
      const plan = planDecision(item, { policy, now, threadExists: deps.threadExists(item.botId, item.threadId), closedKeyRecently });
      const sayKey = `${item.botId}:${item.id}`;
      const fingerprint = `${itemVersion(item)}|${plan.action}|${plan.why}|${policy.mode}`;
      if (plan.action === "wait") continue;
      if (plan.action === "keep") {
        if (said.get(sayKey) !== fingerprint) {
          said.set(sayKey, fingerprint);
          deps.log(`${item.id} of ${deps.botName(item.botId)} ("${item.title.slice(0, 80)}") stays with the owner: ${plan.why}`);
          const entry = entryOf(item, plan);
          deps.audit(entry);
          done.push(entry);
        }
        continue;
      }
      const failKey = `${sayKey}:${itemVersion(item)}`;
      const failed = failures.get(failKey);
      if (failed && (failed.count >= DECISOR_MAX_FAILURES || now - failed.at < DECISOR_RETRY_MS)) continue;
      if (policy.mode === "dry-run") {
        if (said.get(sayKey) !== fingerprint) {
          said.set(sayKey, fingerprint);
          deps.log(`[dry-run] ${item.id} of ${deps.botName(item.botId)} ("${item.title.slice(0, 80)}"): would ${plan.action}${plan.action === "option" ? ` "${plan.label}"` : ""} — ${plan.why}`);
          const entry = entryOf(item, plan, { dryRun: true });
          deps.audit(entry);
          done.push(entry);
        }
        continue;
      }
      acted += 1;
      if (plan.action === "resolve") {
        deps.resolve(item, plan.note);
        deps.log(`${item.id} of ${deps.botName(item.botId)} ("${item.title.slice(0, 80)}") closed: ${plan.note}`);
        const entry = entryOf(item, plan);
        deps.audit(entry);
        done.push(entry);
        continue;
      }
      const body = plan.action === "option" ? { option: plan.index, label: plan.label } : { text: plan.text, resolve: false };
      let answer: RouteAnswer;
      try {
        answer = await deps.reply(item.botId, item.id, body);
      } catch (error) {
        answer = { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
      }
      const ok = answer.status >= 200 && answer.status < 300;
      if (ok) failures.delete(failKey);
      else failures.set(failKey, { count: (failed?.count ?? 0) + 1, at: now });
      const error = ok ? undefined : String(answer.body.error ?? answer.body.code ?? `status ${answer.status}`).slice(0, 300);
      deps.log(`${item.id} of ${deps.botName(item.botId)} ("${item.title.slice(0, 80)}"): ${plan.action === "option" ? `chose "${plan.label}"` : "answered to go ahead"} (${plan.why}) → ${ok ? `sent (${answer.status})` : `NOT sent: ${error}`}`);
      const entry = entryOf(item, plan, { status: answer.status, ...(error ? { error } : {}) });
      deps.audit(entry);
      done.push(entry);
    }
    return done;
  }

  return {
    async tick() {
      if (running) return [];
      running = true;
      try {
        return await pass();
      } finally {
        running = false;
      }
    },
  };
}

/** The audit file: one JSON line per decision; a failed write is logged, never thrown into the pass. */
export function auditTo(path: string, log: (line: string) => void): (entry: DecisorLogEntry) => void {
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`audit not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
