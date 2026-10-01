import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotAutonomy } from "./bot-autonomy.ts";
import { batteryAlert, carrierIntent, isReleaseProcess, LOW_PERCENT, ON_BATTERY_ALERT_MS, parsePmsetBatt, POWER_PENDING_KEY, powerStep, readPowerWatch, startsCarrier } from "./power.ts";

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
    expect(batteryAlert({ power: parsePmsetBatt(both), onBatterySince: 0, now: 1, releaseRunning: false, told: new Set() })!.level).toBe("critical");
    expect(batteryAlert({ power: parsePmsetBatt(ups), onBatterySince: 0, now: ON_BATTERY_ALERT_MS, releaseRunning: false, told: new Set() })!.level).toBe("battery");
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

  it("tells the Chief after 20 min on battery, when low, and when critical — each once", () => {
    const told = new Set<string>();
    const base = { onBatterySince: 0, releaseRunning: true, told };
    expect(batteryAlert({ ...base, power: { onBattery: true, percent: 80 }, now: ON_BATTERY_ALERT_MS - 1 })).toBeNull();
    const long = batteryAlert({ ...base, power: { onBattery: true, percent: 80 }, now: ON_BATTERY_ALERT_MS })!;
    expect(long).toMatchObject({ level: "battery", text: expect.stringContaining("com release de produção em curso") });
    told.add(long.level);
    expect(batteryAlert({ ...base, power: { onBattery: true, percent: 80 }, now: ON_BATTERY_ALERT_MS * 2 })).toBeNull();
    const low = batteryAlert({ ...base, power: { onBattery: true, percent: LOW_PERCENT - 1 }, now: 1 })!;
    expect(low.level).toBe("low");
    told.add(low.level);
    expect(batteryAlert({ ...base, power: { onBattery: true, percent: 12 }, now: 1 })!.text).toContain("PARAR");
    expect(batteryAlert({ ...base, power: { onBattery: false, percent: 12 }, now: 1 })).toBeNull();
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
    expect(first).toMatchObject({ changed: true, resolvePending: false, alert: null });
    // a restart: what was saved comes back, the 20 min keep counting from the first reading
    watch = readPowerWatch(JSON.stringify(first.watch));
    const long = powerStep(watch, { onBattery: true, percent: 80 }, ON_BATTERY_ALERT_MS, true);
    expect(long.alert).toMatchObject({ level: "battery", pendingTitle: "Ligue o Mac na tomada (80%) — release em curso" });
    expect(long.alert!.log).toMatch(/^\[power\] O Mac está na bateria há 20 min/);
    // told once, also after another restart
    expect(powerStep(readPowerWatch(JSON.stringify(long.watch)), { onBattery: true, percent: 80 }, ON_BATTERY_ALERT_MS * 2, true).alert).toBeNull();
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
});
