import { describe, expect, it } from "vitest";
import { batteryAlert, LOW_PERCENT, ON_BATTERY_ALERT_MS, parsePmsetBatt, startsCarrier } from "./power.ts";

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

  it("knows a message that starts a carrier", () => {
    expect(startsCarrier("Rode ./scripts/release-carrier.sh --execute --label hotfix")).toBe(true);
    expect(startsCarrier("pode executar o carrier da #9315 agora")).toBe(true);
    expect(startsCarrier("rode os testes de novo")).toBe(false);
    expect(startsCarrier("o carrier anterior já foi publicado?")).toBe(false);
  });
});
