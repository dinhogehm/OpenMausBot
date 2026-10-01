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
