// The Mac runs releases and gates on battery too: on 01/10 it fell to 24%
// with a production release running, and the app kept it awake until the
// battery would have died mid-deploy (R8-resilience BAT). The server reads
// `pmset -g batt` and, below the owner's limit (20% unless configured), tells
// the Chief (and the person, in "Precisa de você") and holds the Chief's
// carrier orders. It does not hold the production watcher (a LaunchAgent of
// nuria-platform, which reads no battery), and never says it does.

export interface PowerState {
  onBattery: boolean;
  /** Charge, 0–100; null when there is no battery (a desktop Mac). */
  percent: number | null;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'" and " -InternalBattery-0 (id=…)	53%; discharging; …".
 * A no-break (UPS) counts as battery: "drawing from 'UPS Power'" means the
 * wall is out, on a desktop Mac too. With a UPS line and the Mac's own
 * battery, the charge is the Mac's (-InternalBattery-), not the UPS's. */
export function parsePmsetBatt(output: string): PowerState {
  const onBattery = /drawing from '(?:Battery|UPS) Power'/i.test(output);
  const internal = /^\s*-InternalBattery-[^\n]*?\b(\d{1,3})%/m.exec(output);
  const charge = internal ?? /\b(\d{1,3})%/.exec(output);
  return { onBattery, percent: charge ? Math.min(100, Number(charge[1])) : null };
}

// A release process, told by its executable and script, never by free text:
// a `claude -p` carries its whole prompt in argv, and on 01/10 one said
// "… depois ./scripts/release-carrier.sh --check e PARE" with no release
// running (INSP-G r1 G1-a; the same anchoring as release-priority in lot R).
const RELEASE_SCRIPT = String.raw`\S*(?:scripts/(?:\S+/)?(?:local-release|release-carrier|release-production)|watch-production-release)[\w.-]*`;
/** The script run directly (`/x/scripts/local-release.sh …`). */
const RELEASE_DIRECT = new RegExp(`^${RELEASE_SCRIPT}(?:\\s|$)`);
/** The script run by a shell or node (`bash ./scripts/release-carrier.sh --execute`, `/bin/bash -e scripts/macos/release-production.sh`). */
const RELEASE_VIA = new RegExp(`^(?:\\S*/)?(?:(?:ba|z|da)?sh|node)(?:\\s+-\\S+)*\\s+${RELEASE_SCRIPT}(?:\\s|$)`);
/** `npm run release:local` (the title npm sets), or node running npm. */
const RELEASE_NPM = /^(?:(?:\S*\/)?node\s+)?(?:\S*\/)?npm(?:-cli\.js)?(?:\s+-\S+)*\s+run(?:-script)?\s+release(?::\S*)?(?:\s|$)/;
/** Claude Code: `claude …`, or node running its entry point. */
const CLAUDE = /^(?:\S*\/)?claude(?:\s|$)|^(?:\S*\/)?node\s+\S*(?:\/@anthropic-ai\/claude-code\/|\/claude(?:\s|$))/;
/** What may run the release without being it: `caffeinate -i`, `timeout 3600`, `sh -c "…"` (`bash -lc`). */
const WRAPPER = /^(?:(?:\S*\/)?caffeinate(?:\s+-\S+)*\s+|(?:\S*\/)?timeout(?:\s+-\S+)*\s+\S+\s+|(?:\S*\/)?(?:ba|z|da)?sh(?:\s+-(?!\S*c)\S+)*\s+-\S*c\S*\s+["']?)/;

/** A process of a production release (or of a carrier), from `ps -o command`. */
export function isReleaseProcess(command: string): boolean {
  let cmd = command.trim();
  for (let hops = 0; hops < 4; hops++) {
    if (CLAUDE.test(cmd)) return false;
    if (RELEASE_DIRECT.test(cmd) || RELEASE_VIA.test(cmd) || RELEASE_NPM.test(cmd)) return true;
    const wrapper = WRAPPER.exec(cmd);
    if (!wrapper) return false;
    cmd = cmd.slice(wrapper[0].length).trim();
  }
  return false;
}

// The owner's limit (01/10): the battery matters below 20%. Above it, on
// battery or not, nothing is said and nothing is refused — a Mac at 82% on
// battery for 20 min is not news (R9-resilience: the alert of 21:26).
/** The owner's battery limit, in %, unless config.power.batteryMinPercent says otherwise. */
export const DEFAULT_BATTERY_MIN_PERCENT = 20;
/** No charge to read (a no-break): the wall is out; said after this long. */
export const UNKNOWN_CHARGE_ALERT_MS = 20 * 60_000;

/** The limit in force: the configured one when it is a sane percentage, else the default. */
export function batteryMinPercent(configured: unknown): number {
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 99 ? configured : DEFAULT_BATTERY_MIN_PERCENT;
}

/** Below the limit with this little left, the advice is to stop now: half the limit (10% for 20). */
export function criticalPercent(minPercent: number): number {
  return Math.max(1, Math.floor(minPercent / 2));
}

/** Whether the charge is below the owner's limit; a battery whose charge
 * cannot be read (a no-break on a desktop Mac) counts as below: the wall is out. */
export function belowBatteryLimit(power: PowerState, minPercent: number): boolean {
  return power.onBattery && (power.percent === null || power.percent < minPercent);
}

/** What the watcher of production releases does NOT do, said wherever the
 * battery is: it reads no battery and may start a release on its own
 * (R9-resilience BAT-W). Only the Chief's carrier orders are held. */
const WATCHER_IGNORES_BATTERY = "o watcher automático de produção não olha a bateria e ainda pode começar um release sozinho";

/** What to tell, once per level of a discharge below the owner's limit ("low", "critical"), or null. */
export function batteryAlert(input: { power: PowerState; onBatterySince: number | null; now: number; releaseRunning: boolean; told: ReadonlySet<string>; minPercent?: number }): { level: string; text: string } | null {
  const { power } = input;
  const minPercent = input.minPercent ?? DEFAULT_BATTERY_MIN_PERCENT;
  if (!belowBatteryLimit(power, minPercent)) return null;
  const minutes = input.onBatterySince !== null ? Math.max(0, Math.round((input.now - input.onBatterySince) / 60_000)) : null;
  const since = minutes !== null ? ` há ${minutes} min` : "";
  const running = input.releaseRunning ? ", com release de produção em curso" : "";
  if (power.percent === null) {
    // a no-break: no charge to compare, only the time without the wall
    if (minutes === null || input.now - input.onBatterySince! < UNKNOWN_CHARGE_ALERT_MS || input.told.has("low")) return null;
    return { level: "low", text: `Sem tomada (no-break): ligue o Mac na tomada. Está sem energia da tomada${since}, carga desconhecida${running}; o Chief não manda carrier assim, mas ${WATCHER_IGNORES_BATTERY}.` };
  }
  if (power.percent < criticalPercent(minPercent) && !input.told.has("critical")) {
    return { level: "critical", text: `Bateria em ${power.percent}%, quase no fim: ligue o Mac na tomada já. Está na bateria${since}${running}; se desligar no meio de um deploy, a produção fica pela metade — ligue ou peça PARAR: ${WATCHER_IGNORES_BATTERY}.` };
  }
  if (!input.told.has("low") && !input.told.has("critical")) {
    return { level: "low", text: `Bateria em ${power.percent}% (seu limite: ${minPercent}%): ligue o Mac na tomada. Está na bateria${since}${running}; o Chief não manda carrier abaixo de ${minPercent}%, mas ${WATCHER_IGNORES_BATTERY}.` };
  }
  return null;
}

/** What the server remembers of the current discharge (kept on disk, so a
 * restart on battery neither repeats a level nor restarts the count). */
export interface PowerWatchState {
  onBatterySince: number | null;
  told: string[];
  /** onBatterySince was read from `pmset -g log` (when the Mac left the
   * wall), not set when this server first saw the battery. */
  sinceFromLog?: boolean;
}
export const POWER_PENDING_KEY = "power:battery";
export const emptyPowerWatch = (): PowerWatchState => ({ onBatterySince: null, told: [] });

/** A saved PowerWatchState, or an empty one when it is missing or unreadable. */
export function readPowerWatch(json: string | null): PowerWatchState {
  try {
    const value = JSON.parse(json ?? "") as Partial<PowerWatchState>;
    return {
      onBatterySince: typeof value.onBatterySince === "number" ? value.onBatterySince : null,
      told: Array.isArray(value.told) ? value.told.filter((level): level is string => typeof level === "string") : [],
      ...(value.sinceFromLog === true ? { sinceFromLog: true } : {}),
    };
  } catch {
    return emptyPowerWatch();
  }
}

/** When the Mac last left the wall, from `pmset -g log`: the first "Using
 * Batt" after the last "Using AC" ("2026-10-01 20:41:30 -0300 Assertions …
 * Using Batt(Charge: 100)"). With no "Using AC" left in the log, its first
 * "Using Batt" (a lower bound). Null when the log shows no battery, or the
 * Mac is back on AC by the log. */
export function lastUnplugAt(pmsetLog: string, now: number): number | null {
  const events: Array<{ at: number; battery: boolean }> = [];
  for (const line of pmsetLog.split("\n")) {
    const found = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\b.*\bUsing (AC|Batt|BATT)\b/i.exec(line);
    if (!found) continue;
    const at = Date.parse(`${found[1]}T${found[2]}${found[3]}${found[4]}:${found[5]}`);
    if (Number.isFinite(at) && at <= now) events.push({ at, battery: !/^ac$/i.test(found[6]!) });
  }
  const lastAc = events.findLastIndex((event) => !event.battery);
  if (lastAc === events.length - 1) return null;
  return events.slice(lastAc + 1).find((event) => event.battery)?.at ?? null;
}

/** One reading of `pmset`: the next state, whether the "Ligue o Mac na
 * tomada" item must be resolved, and the alert to give, if any. On AC, or
 * back above the owner's limit, the item is resolved — after a restart the
 * memory of the discharge may be gone while the item, saved, is still there
 * (INSP-G r1 G1-b). `unpluggedAt` (from `pmset -g log`) dates the discharge
 * from when the Mac left the wall, not from this server's first look. */
export function powerStep(watch: PowerWatchState, power: PowerState, now: number, releaseRunning: boolean, opts: { minPercent?: number; unpluggedAt?: number | null } = {}): {
  watch: PowerWatchState;
  changed: boolean;
  resolvePending: boolean;
  alert: { level: string; text: string; log: string; pendingTitle: string } | null;
} {
  const minPercent = opts.minPercent ?? DEFAULT_BATTERY_MIN_PERCENT;
  if (!power.onBattery) {
    const changed = watch.onBatterySince !== null || watch.told.length > 0 || watch.sinceFromLog === true;
    return { watch: emptyPowerWatch(), changed, resolvePending: true, alert: null };
  }
  const unplugged = typeof opts.unpluggedAt === "number" && opts.unpluggedAt <= now ? opts.unpluggedAt : null;
  const onBatterySince = unplugged !== null ? Math.min(unplugged, watch.onBatterySince ?? unplugged) : watch.onBatterySince ?? now;
  const below = belowBatteryLimit(power, minPercent);
  const found = batteryAlert({ power, onBatterySince, now, releaseRunning, told: new Set(watch.told), minPercent });
  const next: PowerWatchState = { onBatterySince, told: found ? [...watch.told, found.level] : watch.told, ...(watch.sinceFromLog || unplugged !== null ? { sinceFromLog: true } : {}) };
  const changed = watch.onBatterySince !== onBatterySince || next.told.length !== watch.told.length || next.sinceFromLog !== watch.sinceFromLog;
  if (!found) return { watch: next, changed, resolvePending: !below, alert: null };
  const pendingTitle = `Ligue o Mac na tomada (${power.percent !== null ? `${power.percent}%, abaixo do seu limite de ${minPercent}%` : "no-break, sem tomada"})${releaseRunning ? " — release em curso" : ""}`;
  return { watch: next, changed, resolvePending: false, alert: { ...found, log: `[power] ${found.text}`, pendingTitle } };
}

/** On battery below the owner's limit: an order to run a carrier is refused;
 * a mere mention of one passes with a note. Above the limit: nothing. */
export function carrierBatteryCheck(power: PowerState | null, intent: "order" | "mention" | null, minPercent: number): { refusal: string } | { note: string } | null {
  if (!power || !intent || !belowBatteryLimit(power, minPercent)) return null;
  const charge = power.percent !== null ? `${power.percent}%` : "no-break, carga desconhecida";
  if (intent === "order") return { refusal: `não inicio carrier com o Mac na bateria abaixo do limite do dono (${charge}; limite ${minPercent}%): se ele desligar no meio do deploy, a produção fica pela metade. Peça ao dono para ligar na tomada e mande de novo.` };
  return { note: `[Nota do servidor: Mac na bateria abaixo do limite do dono (${charge}; limite ${minPercent}%): não rode carrier até voltar à tomada.]` };
}

// A message or brief that starts a carrier, as the Chief writes them: the
// script with --execute (flags in any order), a colloquial order whose object
// is the carrier itself ("roda o carrier da #9330", "Publicar: carrier"), or
// the /cpd skill (which ends in the carrier). Not one that negates it ("não
// rode o carrier ainda"), nor one whose object is something else about the
// carrier (its tests, a review, a PR), nor across a clause ("Rode ci:local;
// depois o carrier fica com o Chief"). This only advises: the real gate on
// battery belongs in release-carrier.sh --execute itself (nuria-platform, R8 BAT).
//
// Only an ORDER is refused (INSP-G r2 item 4). A mere mention — the carrier
// that failed yesterday, "investigue", "veja o log", "não é para rodar" —
// passes, with a note that the Mac is on battery: on battery the Chief must
// still be able to send a session to investigate a failed carrier.
const CARRIER_VERB = String.raw`(?:rod(?:a|e|ar)|liber(?:a|e|ar)|toc(?:a|ar)|toque|execut(?:a|e|ar)|mand(?:a|e|ar)|solt(?:a|e|ar)|dispar(?:a|e|ar)|public(?:a|ar)|publique|inici(?:a|e|ar)|lan[çc](?:a|e|ar)|lance|faz|fa[çc]a|fazer|segu(?:e|ir)|siga|vai|v[áa]|run|start|publish|kick\s+off|go)`;
const CARRIER_FILLER = String.raw`(?:o|a|os|as|um|uma|ess[ea]|est[ea]|aquel[ea]|seu|sua|teu|tua|meu|minha|nosso|nossa|com|de|do|da|no|na|em|via|pelo|pela|ver|j[áa]|agora|logo|the|an|this|that|our|your|with)`;
/** Verb, then at most three small words, then the carrier: "roda o carrier", "manda ver no carrier", "Publicar: carrier". */
const ORDER_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}_/-])${CARRIER_VERB}(?:\s*[:\-–—])?(?:\s+${CARRIER_FILLER}){0,3}\s+(?:release-)?carrier\b`, "giu");
/** The carrier, then the order: "Agora o carrier: execute", "carrier da #9330 liberado, pode rodar". */
const ORDER_AFTER = /\bcarrier\b[^:,;]{0,40}[:,]\s*(?:pode\s+|j[áa]\s+)?(rod\w*|execut\w*|solt\w*|dispar\w*|public\w*|mand\w*|run|go)\b/giu;
/** The script and, after it, --execute with only flags (and their values)
 * between: anywhere in a clause ("cd ~/x && ./scripts/release-carrier.sh
 * --label hotfix --execute", "Pode seguir: …"). Not `grep --execute
 * release-carrier.sh`, nor "leia release-carrier.sh e explique o --execute". */
const SCRIPT_EXECUTE = /\S*release-carrier(?:\.sh)?\b`?(?:\s+--?[\w-]+(?:=\S+|\s+(?!-)[^\s`]+)?)*?\s+--execute\b/giu;
/** An order verb as a word. */
const ORDER_VERB = new RegExp(String.raw`(?<![\p{L}\p{N}_/-])${CARRIER_VERB}(?![\p{L}\p{N}_])`, "iu");
/** The /cpd skill (it ends in the carrier) at the start of a clause. */
const ORDER_CPD = /^\s*(?:(?:agora|ent[ãa]o|pode)\s+)?(?:(faz|fa[çc]a|fazer|rod\w*|execut\w*|mand\w*|dispar\w*|solt\w*|lan[çc]\w*|run)\s+)?(?:o\s+)?\/?cpd\b/iu;
/** The carrier or /cpd is talked about. */
const MENTION = /\b(?:release-)?carrier\b|(?:^|\s)\/?cpd\b/iu;
/** Talk about a past run, a failure, its tests or a review. It only turns
 * into a mention a script or /cpd cited WITHOUT an order verb ("…--execute
 * falhou ontem", "o /cpd de ontem falhou"); a verb plus the carrier is an
 * order whatever else the clause says ("Rode o carrier e confira o log"). */
const ABOUT = /\b(?:falh\w*|quebr\w*|trav\w*|erro|errou|logs?|ontem|investig\w*|vej[ao]|veja|confir\w*|analis\w*|testes?|tests?|revis[ãa]o|review|failed|fails?|error|why)\b|por\s*qu[eê]/iu;
/** A negation up to three words before the order ("não rode", "Não é para rodar"), but not "não esqueça de". */
const NEGATED = /(?:\bn[ãa]o|\bnunca|\bjamais|\bdon'?t|\bdo\s+not|\bnever)\s+(?!(?:se\s+)?(?:esque[çc]a|deixe|precisa)\b)(?:\S+\s+){0,3}$/iu;
/** "sem" / "nada de" negate only the verb right after them ("Nada de rodar", "Sem rodar"), not "sem pressa: rode". */
const NEGATED_NEAR = /(?:\bsem|\bnada\s+de)\s+$/iu;
/** "como rodar o carrier", "explique como rodar <script>": an explanation,
 * not an order — but "Como combinado rode", "como sempre rode" are orders. */
const EXPLAINED = /\b(?:como|how\s+to)\s+(?:(?:se\s+)?(?:rodar|executar|soltar|usar|disparar|run|use)\s+)?$/iu;
/** For the script with --execute: only talk of a past run or a failure makes it a mention
 * ("…--execute falhou ontem"); "confira", "veja o log", "os testes passaram" are follow-up steps. */
const PAST_OR_FAILURE = /\b(?:falh\w*|quebr\w*|trav\w*|erro|errou|ontem|investig\w*|failed|fails?|error|why)\b|por\s*qu[eê]/iu;

/** What a message says about the carrier: an "order" to run it, a "mention", or null. */
export function carrierIntent(text: string): "order" | "mention" | null {
  let mention = false;
  // clauses: a ";" or a sentence end closes one (not the dot of "release-carrier.sh")
  for (const clause of text.split(/;|\n|[.!?](?=\s|$)/)) {
    if (!MENTION.test(clause)) continue;
    mention = true;
    const about = ABOUT.test(clause);
    // a negation counts only within its comma-part: "não precisa esperar, rode o carrier" is an order
    // a negation reaches back to a comma or a colon ("sem pendências: solte o carrier")
    const negationPart = (at: number) => clause.slice(0, at).split(/[,:]/).pop()!;
    const negated = (at: number) => [NEGATED, NEGATED_NEAR, EXPLAINED].some((pattern) => pattern.test(negationPart(at)));
    // an order verb reaches over a colon ("Rode no nuria-platform: <script>"), not over a comma
    const verbPart = (at: number) => clause.slice(0, at).split(",").pop()!;
    const starts = [0, ...[...clause.matchAll(/,/g)].map((match) => match.index! + 1)];
    // the script with --execute, anywhere: an order with an order verb before it, or with no talk of a past run or a failure
    const pastOrFailure = PAST_OR_FAILURE.test(clause);
    const scripts = [...clause.matchAll(SCRIPT_EXECUTE)].map((match) => match.index!).filter((at) => ORDER_VERB.test(verbPart(at)) || !pastOrFailure);
    // /cpd at the start of a comma-part: the same
    const cpd = starts.filter((at) => {
      const found = ORDER_CPD.exec(clause.slice(at));
      return found !== null && (found[1] !== undefined || !about);
    });
    const orders = [
      ...[...clause.matchAll(ORDER_BEFORE)].map((match) => match.index!),
      ...[...clause.matchAll(ORDER_AFTER)].map((match) => match.index! + match[0].lastIndexOf(match[1]!)),
      ...scripts,
      ...cpd.map((at) => at + (clause.slice(at).length - clause.slice(at).trimStart().length)),
    ];
    if (orders.some((at) => !negated(at))) return "order";
  }
  return mention ? "mention" : null;
}

/** A message or brief that orders a carrier run. */
export function startsCarrier(text: string): boolean {
  return carrierIntent(text) === "order";
}
