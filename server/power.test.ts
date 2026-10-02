import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotAutonomy } from "./bot-autonomy.ts";
import { batteryAlert, batteryMinPercent, carrierBatteryCheck, carrierIntent, DEFAULT_BATTERY_MIN_PERCENT, isReleaseProcess, lastUnplugAt, parsePmsetBatt, POWER_PENDING_KEY, powerStep, readPowerWatch, startsCarrier, UNKNOWN_CHARGE_ALERT_MS } from "./power.ts";

const onBattery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=27525219)\t53%; discharging; 1:16 remaining present: true\n";
const plugged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=27525219)\t100%; charged; 0:00 remaining present: true\n";

describe("power", () => {
  it("reads pmset", () => {
    expect(parsePmsetBatt(onBattery)).toEqual({ onBattery: true, percent: 53 });
    expect(parsePmsetBatt(plugged)).toEqual({ onBattery: false, percent: 100 });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toEqual({ onBattery: false, percent: null });
  });

  it("counts a no-break as battery, and reads the Mac's own charge beside a UPS (INSP-G r1 item 9)", () => {
    // a desktop Mac on a no-break: the wall is out
    const ups = "Now drawing from 'UPS Power'\n -UPS-1500VA (id=1234567)\t87%; discharging; 0:45 remaining present: true\n";
    expect(parsePmsetBatt(ups)).toEqual({ onBattery: true, percent: 87 });
    // a laptop beside a UPS: the UPS line comes first, the charge that matters is the Mac's
    const both = "Now drawing from 'Battery Power'\n -UPS-1500VA (id=1234567)\t100%; charged; 0:00 remaining present: true\n -InternalBattery-0 (id=7340131)\t12%; discharging; 0:20 remaining present: true\n";
    expect(parsePmsetBatt(both)).toEqual({ onBattery: true, percent: 12 });
    // 12%: below the owner's 20%, not yet critical (10%)
    expect(batteryAlert({ power: parsePmsetBatt(both), onBatterySince: 0, now: 1, releaseRunning: false, told: new Set() })!.level).toBe("low");
    // the UPS at 87% is above the limit like any battery
    expect(batteryAlert({ power: parsePmsetBatt(ups), onBatterySince: 0, now: UNKNOWN_CHARGE_ALERT_MS, releaseRunning: false, told: new Set() })).toBeNull();
    // a no-break whose charge cannot be read: the wall is out, said after 20 min
    const blind = { onBattery: true, percent: null };
    expect(batteryAlert({ power: blind, onBatterySince: 0, now: UNKNOWN_CHARGE_ALERT_MS - 1, releaseRunning: false, told: new Set() })).toBeNull();
    expect(batteryAlert({ power: blind, onBatterySince: 0, now: UNKNOWN_CHARGE_ALERT_MS, releaseRunning: false, told: new Set() })!.text).toContain("no-break, carga desconhecida");
    // the real AC reading of 01/10, and its variants, stay off battery
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=7340131)\t99%; finishing charge; 0:31 remaining present: true\n")).toEqual({ onBattery: false, percent: 99 });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=7340131)\t80%; AC attached; not charging present: true\n")).toEqual({ onBattery: false, percent: 80 });
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=7340131)\t53%; discharging; (no estimate) present: true\n")).toEqual({ onBattery: true, percent: 53 });
    expect(parsePmsetBatt("")).toEqual({ onBattery: false, percent: null });
  });

  it("sees a release by its executable and script, never in a claude's prompt (INSP-G r1 item 6)", () => {
    // the line of 01/10 (pid 91537): no release was running
    const claudeLine = "claude -p --resume 29da943f-0000-4000-8000-000000000000 -- Conferi: head da #9330 bate com o gate. Agora `npm run pr:merge -- --pr 9330 --merge`, depois `./scripts/release-carrier.sh --check` e PARE";
    expect(isReleaseProcess(claudeLine)).toBe(false);
    expect(isReleaseProcess("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js -p -- rode bash ./scripts/local-release.sh")).toBe(false);
    expect(isReleaseProcess("/bin/zsh -c npm run ci:local && ./scripts/release-carrier.sh --check")).toBe(false);
    expect(isReleaseProcess("grep release-carrier scripts/README.md")).toBe(false);
    expect(isReleaseProcess("vim scripts/local-release.sh")).toBe(false);
    for (const line of [
      "bash ./scripts/local-release.sh --sha c88f99d6",
      "/bin/bash ./scripts/release-carrier.sh --pr 9330 --execute",
      "/bin/bash -e scripts/macos/release-production.sh",
      "/Users/owner/Projetos/nuria-platform/scripts/local-release.sh",
      "/bin/bash /Users/owner/.local/bin/watch-production-release.sh",
      "npm run release:local",
    ]) expect(isReleaseProcess(line), line).toBe(true);
  });

  it("sees a release behind caffeinate, timeout or sh -c, never a claude's (INSP-G r2 item 5)", () => {
    for (const line of [
      "caffeinate -i ./scripts/local-release.sh",
      "/usr/bin/caffeinate -dims bash scripts/macos/release-production.sh",
      "timeout 3600 bash scripts/local-release.sh",
      "/bin/sh -c npm run release:local",
      "bash -lc \"./scripts/release-carrier.sh --execute\"",
      "/bin/zsh -c ./scripts/release-carrier.sh --execute",
      "node /opt/homebrew/bin/npm run release:local",
    ]) expect(isReleaseProcess(line), line).toBe(true);
    for (const line of [
      "claude -p -- rode ./scripts/release-carrier.sh --execute",
      "caffeinate -i claude -p -- rode ./scripts/local-release.sh",
      "/bin/zsh -c npm run ci:local && ./scripts/release-carrier.sh --check",
      "timeout 60 grep release-carrier scripts/README.md",
      "caffeinate -dims",
    ]) expect(isReleaseProcess(line), line).toBe(false);
  });

  it("says nothing above the owner's 20%, however long on battery (R9-resilience: the alert of 21:26 at 82%)", () => {
    const base = { onBatterySince: 0, releaseRunning: true, told: new Set<string>() };
    for (const percent of [100, 82, 30, 20]) {
      expect(batteryAlert({ ...base, power: { onBattery: true, percent }, now: 6 * 3_600_000 }), `${percent}%`).toBeNull();
    }
    expect(DEFAULT_BATTERY_MIN_PERCENT).toBe(20);
  });

  it("tells the Chief below the limit, then when critical — each once, and never promises what the watcher does not do", () => {
    const told = new Set<string>();
    const base = { onBatterySince: 0, releaseRunning: true, told };
    const low = batteryAlert({ ...base, power: { onBattery: true, percent: 19 }, now: 45 * 60_000 })!;
    expect(low).toEqual({ level: "low", text: "O Mac está na bateria há 45 min com 19%, abaixo do seu limite de 20%, com release de produção em curso. Ligue na tomada: o Chief não manda carrier abaixo de 20%, mas o watcher automático de produção não olha a bateria e ainda pode começar um release sozinho." });
    expect(low.text).not.toMatch(/nenhum carrier novo começa/);
    told.add(low.level);
    expect(batteryAlert({ ...base, power: { onBattery: true, percent: 15 }, now: 50 * 60_000 })).toBeNull();
    const critical = batteryAlert({ ...base, power: { onBattery: true, percent: 9 }, now: 80 * 60_000 })!;
    expect(critical.level).toBe("critical");
    expect(critical.text).toContain("PARAR");
    expect(critical.text).toContain("não olha a bateria");
    told.add(critical.level);
    expect(batteryAlert({ ...base, power: { onBattery: true, percent: 5 }, now: 90 * 60_000 })).toBeNull();
    expect(batteryAlert({ ...base, power: { onBattery: false, percent: 12 }, now: 1 })).toBeNull();
    // a Mac found already critical is told once, not "low" after it
    const late = new Set<string>(["critical"]);
    expect(batteryAlert({ ...base, told: late, power: { onBattery: true, percent: 8 }, now: 1 })).toBeNull();
  });

  it("takes the owner's limit from the config: alerts and carrier refusals follow it", () => {
    expect(batteryMinPercent(undefined)).toBe(20);
    expect(batteryMinPercent(35)).toBe(35);
    for (const bad of [0, 100, 12.5, "30", null]) expect(batteryMinPercent(bad), String(bad)).toBe(20);
    expect(batteryAlert({ power: { onBattery: true, percent: 30 }, onBatterySince: 0, now: 1, releaseRunning: false, told: new Set(), minPercent: 35 })!.text).toContain("abaixo do seu limite de 35%");
    // a carrier ORDER is held only below the limit; a mention passes with a note, also only below it
    expect(carrierBatteryCheck({ onBattery: true, percent: 82 }, "order", 20)).toBeNull();
    expect(carrierBatteryCheck({ onBattery: true, percent: 20 }, "order", 20)).toBeNull();
    expect(carrierBatteryCheck({ onBattery: false, percent: 5 }, "order", 20)).toBeNull();
    expect(carrierBatteryCheck({ onBattery: true, percent: 19 }, "order", 20)).toEqual({ refusal: "não inicio carrier com o Mac na bateria abaixo do limite do dono (19%; limite 20%): se ele desligar no meio do deploy, a produção fica pela metade. Peça ao dono para ligar na tomada e mande de novo." });
    expect(carrierBatteryCheck({ onBattery: true, percent: 19 }, "mention", 20)).toMatchObject({ note: expect.stringContaining("não rode carrier até voltar à tomada") });
    expect(carrierBatteryCheck({ onBattery: true, percent: 19 }, null, 20)).toBeNull();
    expect(carrierBatteryCheck({ onBattery: true, percent: 30 }, "order", 35)).toMatchObject({ refusal: expect.stringContaining("limite 35%") });
  });

  it("counts the discharge from when the Mac left the wall, read from pmset -g log (R9-resilience BAT-T0)", () => {
    // the real lines of 01/10: on AC until 20:41:30, then on battery; the server booted at 21:06
    const log = [
      "2026-10-01 17:55:03 -0300 Assertions          \tSummary- [System: PrevIdle PrevSleep DeclUser kCPU kDisp] Using AC(Charge: 100)          ",
      "2026-10-01 20:41:30 -0300 Assertions          \tSummary- [System: PrevIdle PrevDisp DeclUser kDisp] Using Batt(Charge: 100)          ",
      "2026-10-01 21:02:11 -0300 Assertions          \tSummary- [System: PrevIdle DeclUser kDisp] Using Batt(Charge: 88)          ",
    ].join("\n");
    const unplugged = Date.parse("2026-10-01T20:41:30-03:00");
    const boot = Date.parse("2026-10-01T21:06:21-03:00");
    expect(lastUnplugAt(log, boot)).toBe(unplugged);
    // back on AC by the log, no battery, or only battery left in a rotated log
    expect(lastUnplugAt(`${log}\n2026-10-01 21:30:00 -0300 Assertions Summary- Using AC(Charge: 70)`, boot + 3_600_000)).toBeNull();
    expect(lastUnplugAt("", boot)).toBeNull();
    expect(lastUnplugAt(log.split("\n").slice(1).join("\n"), boot)).toBe(unplugged);
    // the first look at 21:06 counts from 20:41, and is kept across a restart
    const first = powerStep(readPowerWatch(null), { onBattery: true, percent: 19 }, boot, false, { unpluggedAt: unplugged });
    expect(first.watch).toEqual({ onBatterySince: unplugged, told: ["low"], sinceFromLog: true });
    expect(first.alert!.text).toContain("na bateria há 25 min com 19%");
    // a state saved by an earlier build (counted from its boot) is moved back to the unplugging
    const saved = powerStep({ onBatterySince: boot, told: [] }, { onBattery: true, percent: 82 }, boot + 60_000, false, { unpluggedAt: unplugged });
    expect(saved).toMatchObject({ changed: true, alert: null, watch: { onBatterySince: unplugged, sinceFromLog: true } });
    expect(readPowerWatch(JSON.stringify(saved.watch))).toEqual(saved.watch);
  });

  it("resolves \"Ligue o Mac na tomada\" on AC even after a restart forgot the discharge (INSP-G r1 item 7)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-power-"));
    try {
      const autonomy = new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => 1_000 });
      autonomy.addOwnerPending("chief", "desk", { title: "Ligue o Mac na tomada (24%)", key: POWER_PENDING_KEY });
      // the server restarts (memory empty), the Mac is back on AC
      const restarted = new BotAutonomy({ path: join(dir, "bot-autonomy.json"), now: () => 2_000 });
      expect(restarted.ownerPendingFor("desk")).toHaveLength(1);
      const step = powerStep(readPowerWatch(null), parsePmsetBatt(plugged), 2_000, false);
      expect(step.resolvePending).toBe(true);
      expect(step.alert).toBeNull();
      if (step.resolvePending) restarted.resolveOwnerPending({ key: POWER_PENDING_KEY });
      expect(restarted.ownerPendingFor("desk")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the discharge across a restart, and logs the battery alert as [power] (items 7 and 11)", () => {
    let watch = readPowerWatch(null);
    const first = powerStep(watch, { onBattery: true, percent: 80 }, 0, false);
    // above the limit: counted, nothing said, the item (if any) closed
    expect(first).toMatchObject({ changed: true, resolvePending: true, alert: null });
    // a restart: what was saved comes back, the count goes on from the first reading
    watch = readPowerWatch(JSON.stringify(first.watch));
    const low = powerStep(watch, { onBattery: true, percent: 19 }, 30 * 60_000, true);
    expect(low.alert).toMatchObject({ level: "low", pendingTitle: "Ligue o Mac na tomada (19%, abaixo do seu limite de 20%) — release em curso" });
    expect(low.alert!.log).toMatch(/^\[power\] O Mac está na bateria há 30 min com 19%/);
    expect(low.resolvePending).toBe(false);
    // told once, also after another restart
    expect(powerStep(readPowerWatch(JSON.stringify(low.watch)), { onBattery: true, percent: 17 }, 40 * 60_000, true).alert).toBeNull();
    expect(readPowerWatch("{broken")).toEqual({ onBatterySince: null, told: [] });
  });

  it("knows a message that starts a carrier", () => {
    expect(startsCarrier("Rode ./scripts/release-carrier.sh --execute --label hotfix")).toBe(true);
    expect(startsCarrier("pode executar o carrier da #9315 agora")).toBe(true);
    expect(startsCarrier("rode os testes de novo")).toBe(false);
    expect(startsCarrier("o carrier anterior já foi publicado?")).toBe(false);
  });

  it("refuses the carrier orders the Chief really writes, and lets the rest through (INSP-G r1 item 8, OMB side)", () => {
    const starts = [
      "roda o carrier da #9330",
      "manda o carrier",
      "executa o carrier",
      "solta o carrier",
      "dispare o carrier agora",
      "faz o /cpd",
      "cpd da #9330",
      "./scripts/release-carrier.sh --pr 9330 --execute",
      "bash scripts/release-carrier.sh --label hotfix --execute",
      "rodar carrier",
      "Publicar: carrier da #9315",
      "Conferi o gate. Agora rode o release-carrier da #9330",
      "Run the carrier for #9330",
    ];
    const passes = [
      "não rode o carrier ainda, só o --check",
      "execute os testes do release-carrier.sh",
      "inicie a revisão do PR que mexe no carrier",
      "run the unit tests for carrier parsing",
      "Rode ci:local no head; depois o carrier fica com o Chief",
      "rode ./scripts/release-carrier.sh --check e PARE",
      "não rode ./scripts/release-carrier.sh --execute; só o --check",
      "rode os testes de novo",
      "o carrier anterior já foi publicado?",
      "Conferi: head da #9330 bate. Rode ci:local no head e PARE.",
    ];
    for (const text of starts) expect(startsCarrier(text), text).toBe(true);
    for (const text of passes) expect(startsCarrier(text), text).toBe(false);
  });

  it("refuses only an order; a mention passes with the battery note (INSP-G r2 item 4, the inspector's 31 phrases)", () => {
    const order: string[] = [
      "roda o carrier da #9330", "manda o carrier", "dispare o carrier agora", "faz o /cpd", "cpd da #9330",
      "bash scripts/release-carrier.sh --label hotfix --execute", "./scripts/release-carrier.sh --pr 9330 --execute", "./scripts/release-carrier.sh --execute --label x",
      "solta o carrier", "executa o carrier", "rodar carrier", "Publicar: carrier da #9315",
      "pode rodar o carrier da #9330 agora", "segue com o carrier", "vai de carrier", "manda ver no carrier",
      "Pode publicar via carrier", "Agora o carrier: execute.", "carrier da #9330 liberado, pode rodar",
      "não esqueça de rodar o carrier", "não precisa esperar, rode o carrier",
    ];
    const mention: string[] = [
      "nao rode o carrier ainda, so o --check", "rode ./scripts/release-carrier.sh --check e PARE",
      "execute os testes do release-carrier.sh", "inicie a revisao do PR que mexe no carrier",
      "run the unit tests for carrier parsing", "Rode ci:local no head; depois o carrier fica com o Chief",
      "o /cpd de ontem falhou, veja o log", "Não é para rodar o carrier", "confira se o carrier anterior publicou",
      "release-carrier.sh --execute falhou ontem com GH013, investigue",
    ];
    expect(order.length + mention.length).toBe(31);
    for (const text of order) expect(carrierIntent(text), text).toBe("order");
    for (const text of mention) expect(carrierIntent(text), text).toBe("mention");
    expect(carrierIntent("rode os testes de novo")).toBeNull();
  });

  it("an order stays an order when the clause also talks of logs, tests or errors (INSP-G r3, the inspector's 14 new phrases)", () => {
    const order = [
      "Rode o carrier da #9330 e confira o log depois",
      "rode os testes e depois rode o carrier",
      "Rode o carrier e veja se a produção subiu",
      "rode o carrier, depois confira a planilha",
      "Rode release-carrier.sh --execute --label hotfix e confirme no log",
      "Carrier falhou ontem por GH013; rode o carrier de novo",
      "O erro foi corrigido, rode o carrier",
      "Rode o carrier agora (os testes já passaram)",
      "Mergeie a #9330 e rode o carrier",
      "pode soltar o carrier",
      "Rodar o carrier: sim",
      "libere o carrier",
      "toca o carrier",
      "Dispara o /cpd",
    ];
    expect(order).toHaveLength(14);
    for (const text of order) expect(carrierIntent(text), text).toBe("order");
    // a script or /cpd cited without a verb, in talk about a failure, stays a mention
    expect(carrierIntent("release-carrier.sh --execute falhou ontem com GH013, investigue")).toBe("mention");
    expect(carrierIntent("o /cpd de ontem falhou, veja o log")).toBe("mention");
  });

  it("the script with --execute is an order anywhere in the clause (INSP-G r4: the 11 wordings and the 24 new phrases)", () => {
    const script = "./scripts/release-carrier.sh --execute --label hotfix";
    const wordings = [
      `\`${script}\``, `Rode no nuria-platform: \`${script}\``, `Rode:\n${script}`, `Pode seguir: ${script}`, `Próximo passo é ${script}`,
      `cd ~/Projetos/nuria-platform && ${script}`, `Com a #9330 mergeada, ${script}`, `Rode \`${script}\` e mande o resultado`,
      `Execute agora \`${script}\``, `Rode o comando \`${script}\``, `Depois do merge rode ${script}`,
    ];
    for (const text of wordings) expect(carrierIntent(text), text).toBe("order");
    const phrases: Array<[string, "order" | "mention"]> = [
      ["Veja o log do CI e, se verde, rode o carrier", "order"], ["Investigue a falha e depois solte o carrier", "order"],
      ["Testes verdes: pode rodar o carrier", "order"], ["Confirmado no log; agora rode o carrier da #9330", "order"],
      ["Depois do merge, execute o carrier com --label hotfix", "order"], ["Rode a release (carrier) da #9330", "mention"],
      ["Rode release-carrier.sh --label hotfix --execute e depois veja o log", "order"], ["cd ~/Projetos/nuria-platform && ./scripts/release-carrier.sh --execute --label x", "order"],
      ["Faça o /cpd da #9330 e confira a produção", "order"], ["libera o carrier e confere a planilha", "order"],
      ["Por que o carrier de ontem demorou? Veja o log", "mention"], ["O carrier rodou ontem às 14h, confira se publicou", "mention"],
      ["Rodaram o carrier duas vezes ontem; investigue", "mention"], ["revise o PR que muda o release-carrier.sh", "mention"],
      ["escreva testes para o carrier", "mention"], ["documente como rodar o carrier no README", "mention"],
      ["o carrier da #9327 já publicou?", "mention"], ["veja o log do carrier", "mention"],
      ["grep -n --execute scripts/release-carrier.sh", "mention"], ["leia release-carrier.sh e explique o --execute", "mention"],
      ["status do carrier, por favor", "mention"], ["Não rode o carrier; investigue o log", "mention"],
      ["Nada de rodar o carrier hoje", "mention"], ["Sem carrier por enquanto, só o PR", "mention"],
    ];
    expect(phrases).toHaveLength(24);
    for (const [text, want] of phrases) expect(carrierIntent(text), text).toBe(want);
    // "sem" / "nada de" negate only the verb right after them; a colon closes the part (INSP-G r5)
    for (const text of ["Pode seguir sem pressa: rode o carrier", "sem mais delongas rode o carrier", "Tudo verde, sem pendências: solte o carrier", "Sem bloqueio no gate rode o carrier"]) expect(carrierIntent(text), text).toBe("order");
    for (const text of ["Nada de rodar o carrier hoje", "Sem rodar o carrier até eu mandar", `explique como rodar ${script}`]) expect(carrierIntent(text), text).toBe("mention");
    // INSP-G r6: a colon does not hide the verb from the script; follow-up steps do not veto it; "Como combinado" is no explanation
    for (const text of [
      `Rode no nuria-platform: \`${script}\` e confira o log`,
      `Rode: ${script} e veja o log depois`,
      `Execute agora: ${script} (os testes já passaram)`,
      `Pode rodar: ${script} — depois confirme a produção`,
      `Próximo passo: ${script} e confira a planilha`,
      "Como combinado rode o carrier",
      "como sempre rode o carrier",
      "Faça como ontem: rode o carrier",
    ]) expect(carrierIntent(text), text).toBe("order");
    for (const text of [`O ${script} de ontem travou; veja o log`, `Ontem você rodou ${script}; confira`]) expect(carrierIntent(text), text).toBe("mention");
    // still a mention: the script cited in talk about a failure, or negated
    expect(carrierIntent("release-carrier.sh --execute falhou ontem com GH013, investigue")).toBe("mention");
    expect(carrierIntent("não rode ./scripts/release-carrier.sh --execute; só o --check")).toBe("mention");
  });
});
