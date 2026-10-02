import { describe, expect, it } from "vitest";
import { echoAsk, ownerAskText, OWNER_PENDING_TITLE_MAX } from "./bot-autonomy.ts";
import { appUnblockPending } from "./owner-chips.ts";
import { powerPendingDetails } from "./power.ts";
import { releaseLoopPending, tagAdvancePending } from "./release-watch.ts";

// R10-visual N12, the five conversation lines of "Precisa de você" on 02/10
// (GET /api/bots, goalNeedsInputAsk), redacted: the owner is "Renata", the
// client is "a cliente". Four only echo the panel or another item, or say
// nothing; the fifth is a real ask.
const BOTS = ["Chief of Staff", "Monitor Chat Atendimento", "Delivery PRODEV"];
const OPEN_IDS = ["o1", "o2", "o3", "o4", "o6", "o8", "o14", "o15", "o16"];
const ECHOES = [
  "Preciso de você",
  "O pedido continua na sua lista 'Precisa de você' (o15).",
  "O Monitor abriu a pendência o6 em 'Precisa de você'.",
  "Precisa de você: o Chief deixou no seu 'Precisa de você' um pedido sobre duas issues da cliente:",
];
const REAL = "Renata, a sessão da #9058 está pronta para o gate, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?";

describe("the lines of \"Precisa de você\" that say nothing of their own", () => {
  it("drops the four echoes of 02/10 and keeps the real ask: 5 lines become 1", () => {
    for (const ask of ECHOES) expect(echoAsk(ownerAskText(ask, 200, BOTS), OPEN_IDS), ask).toBe(true);
    expect(echoAsk(ownerAskText(REAL, 200, BOTS), OPEN_IDS)).toBe(false);
    expect([...ECHOES, REAL].filter((ask) => !echoAsk(ownerAskText(ask, 200, BOTS), OPEN_IDS))).toEqual([REAL]);
  });

  it("an item id counts only when it is an open item's; a real ask naming the panel in passing is no echo", () => {
    expect(echoAsk("Posso fechar o o14 e liberar o gate da #9348?", OPEN_IDS)).toBe(true);
    expect(echoAsk("Posso liberar o gate da #9348 agora?", OPEN_IDS)).toBe(false);
    expect(echoAsk("Aprovo o deploy do helpdesk hoje às 18h?", [])).toBe(false);
    expect(echoAsk("Renata, preciso de você.", [])).toBe(true);
    expect(echoAsk("", [])).toBe(true);
  });

  it("the vocative is who, not what: the title starts at the ask", () => {
    expect(ownerAskText(REAL, 200, BOTS)).toBe("A sessão da #9058 está pronta para o gate, mas o timeout do pre-push depende de uma decisão sua: 10 min ou sem limite?");
    // a sentence that only starts with a capital word and a comma is not a vocative
    expect(ownerAskText("Pronto, posso seguir com o carrier?", 200, BOTS)).toBe("Pronto, posso seguir com o carrier?");
  });
});

// R10-visual N13: 11 of 12 items had no why, steps nor options — even the
// server's own o8. Each item the server creates is born practical.
describe("the items the server creates come with why, steps and options", () => {
  const FULL = "d5bb1f70bea397bdd937d02148c685e406985ba0";
  const practical = (item: { title: string; why?: string; steps?: Array<{ text: string; command?: string }>; options?: Array<{ label: string; reply: string }> }) => {
    expect(item.title.length).toBeLessThanOrEqual(OWNER_PENDING_TITLE_MAX);
    expect(item.why?.length ?? 0).toBeGreaterThan(40);
    expect(item.why!.length).toBeLessThanOrEqual(400);
    expect(item.steps?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const option of item.options ?? []) expect(option.label.length).toBeLessThanOrEqual(40);
    expect(`${item.title} ${item.why} ${item.steps!.map((step) => step.text).join(" ")}`).not.toMatch(/\b(?:the|and|click|open|run)\b/i);
  };

  it("unblock the app (askOwnerToUnblockApp)", () => {
    const item = appUnblockPending("nuria-platform");
    practical(item);
    expect(item.steps.map((step) => step.text).join("\n")).toContain("raiz do repositório nuria-platform");
    expect(item.options.map((option) => option.label)).toEqual(["Feito", "Deixar no terminal"]);
  });

  it("a release in a loop, the stuck tag, the battery", () => {
    practical(releaseLoopPending({ short: "d5bb1f70b", full: FULL, count: 10, cycleMs: 50 * 60_000 }));
    const manual = `git tag -f nuria-production-deployed ${FULL} && git push --force-with-lease origin nuria-production-deployed`;
    const tag = tagAdvancePending(FULL, manual);
    practical(tag);
    expect(tag).toMatchObject({ key: `tag-advance:${FULL}`, command: manual });
    expect(tag.steps[0]).toMatchObject({ command: manual });
    // without the printed advance: no command invented, the log is named
    const blind = tagAdvancePending(FULL, null);
    expect(blind.command).toBeUndefined();
    expect(blind.steps[0]!.text).toContain("log do servidor");
    const power = powerPendingDetails(true);
    practical({ title: "Ligue o Mac na tomada (12%, abaixo do seu limite de 20%) — release em curso", ...power });
    expect(power.why).toContain("o release de produção que está em curso");
    expect(power.why).toContain("O watcher automático de produção não olha a bateria");
  });
});
