// The Mac runs releases and gates on battery too: on 01/10 it fell to 24%
// with a production release running, and the app kept it awake until the
// battery would have died mid-deploy (R8-resilience BAT). The server reads
// `pmset -g batt` and tells the Chief (and the person, in "Precisa de
// você") when the Mac has been on battery for a while or is running low,
// and it does not start a release carrier on battery.

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

/** On battery this long, or below LOW_PERCENT, the Chief hears it. */
export const ON_BATTERY_ALERT_MS = 20 * 60_000;
export const LOW_PERCENT = 30;
/** Below this, with a release or a gate running, the advice is to stop. */
export const CRITICAL_PERCENT = 15;

/** What to tell, once per level of a discharge ("battery", "low", "critical"), or null. */
export function batteryAlert(input: { power: PowerState; onBatterySince: number | null; now: number; releaseRunning: boolean; told: ReadonlySet<string> }): { level: string; text: string } | null {
  const { power } = input;
  if (!power.onBattery) return null;
  const percent = power.percent ?? 100;
  const long = input.onBatterySince !== null && input.now - input.onBatterySince >= ON_BATTERY_ALERT_MS;
  const running = input.releaseRunning ? ", com release de produção em curso" : "";
  const charge = power.percent === null ? "" : ` (${power.percent}%)`;
  if (percent < CRITICAL_PERCENT && !input.told.has("critical")) {
    return { level: "critical", text: `O Mac está na bateria e quase sem carga${charge}${running}. Se ele desligar no meio de um deploy, a produção fica pela metade: ligue na tomada já, ou peça PARAR antes de começar outro carrier.` };
  }
  if (percent < LOW_PERCENT && !input.told.has("low")) {
    return { level: "low", text: `O Mac está na bateria com carga baixa${charge}${running}. Ligue na tomada; nenhum carrier novo começa na bateria.` };
  }
  if (long && !input.told.has("battery")) {
    return { level: "battery", text: `O Mac está na bateria há ${Math.round((input.now - input.onBatterySince!) / 60_000)} min${charge}${running}. Ligue na tomada; nenhum carrier novo começa na bateria.` };
  }
  return null;
}

/** What the server remembers of the current discharge (kept on disk, so a
 * restart on battery neither repeats a level nor restarts the 20 min). */
export interface PowerWatchState {
  onBatterySince: number | null;
  told: string[];
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
    };
  } catch {
    return emptyPowerWatch();
  }
}

/** One reading of `pmset`: the next state, whether the "Ligue o Mac na
 * tomada" item must be resolved, and the alert to give, if any. On AC the
 * item is always resolved — after a restart the memory of the discharge may
 * be gone while the item, saved, is still there (INSP-G r1 G1-b). */
export function powerStep(watch: PowerWatchState, power: PowerState, now: number, releaseRunning: boolean): {
  watch: PowerWatchState;
  changed: boolean;
  resolvePending: boolean;
  alert: { level: string; text: string; log: string; pendingTitle: string } | null;
} {
  if (!power.onBattery) {
    const changed = watch.onBatterySince !== null || watch.told.length > 0;
    return { watch: emptyPowerWatch(), changed, resolvePending: true, alert: null };
  }
  const onBatterySince = watch.onBatterySince ?? now;
  const found = batteryAlert({ power, onBatterySince, now, releaseRunning, told: new Set(watch.told) });
  const next = { onBatterySince, told: found ? [...watch.told, found.level] : watch.told };
  const changed = watch.onBatterySince !== onBatterySince || next.told.length !== watch.told.length;
  if (!found) return { watch: next, changed, resolvePending: false, alert: null };
  const pendingTitle = `Ligue o Mac na tomada${power.percent !== null ? ` (${power.percent}%)` : ""}${releaseRunning ? " — release em curso" : ""}`;
  return { watch: next, changed, resolvePending: false, alert: { ...found, log: `[power] ${found.text}`, pendingTitle } };
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
/** The script with --execute at the start of a clause (or right after an order verb or a shell). */
const ORDER_SCRIPT = new RegExp(String.raw`^\s*(?:(?:agora|ent[ãa]o|pode)\s+)?(?:(${CARRIER_VERB})\s+)?(?:(?:\S*/)?(?:ba|z)?sh\s+)?\S*release-carrier(?:\.sh)?\b[^\n]*?\s--execute\b`, "iu");
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

/** What a message says about the carrier: an "order" to run it, a "mention", or null. */
export function carrierIntent(text: string): "order" | "mention" | null {
  let mention = false;
  // clauses: a ";" or a sentence end closes one (not the dot of "release-carrier.sh")
  for (const clause of text.split(/;|\n|[.!?](?=\s|$)/)) {
    if (!MENTION.test(clause)) continue;
    mention = true;
    const about = ABOUT.test(clause);
    // a negation counts only within its comma-part: "não precisa esperar, rode o carrier" is an order
    const negated = (at: number) => NEGATED.test(clause.slice(0, at).split(",").pop()!);
    const starts = [0, ...[...clause.matchAll(/,/g)].map((match) => match.index! + 1)];
    // a script or /cpd at the start of a comma-part: an order with a verb, or with no talk "about" it
    const cited = starts.filter((at) => {
      const part = clause.slice(at);
      const found = ORDER_SCRIPT.exec(part) ?? ORDER_CPD.exec(part);
      return found !== null && (found[1] !== undefined || !about);
    });
    const orders = [
      ...[...clause.matchAll(ORDER_BEFORE)].map((match) => match.index!),
      ...[...clause.matchAll(ORDER_AFTER)].map((match) => match.index! + match[0].lastIndexOf(match[1]!)),
      ...cited.map((at) => at + (clause.slice(at).length - clause.slice(at).trimStart().length)),
    ];
    if (orders.some((at) => !negated(at))) return "order";
  }
  return mention ? "mention" : null;
}

/** A message or brief that orders a carrier run. */
export function startsCarrier(text: string): boolean {
  return carrierIntent(text) === "order";
}
