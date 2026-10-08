import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const GIT_DIR = ["/usr/bin", "/bin"].find((dir) => existsSync(join(dir, "git"))) ?? "";
const toolResult = (turn: any, tool: string) =>
  turn.evidence.findLast((entry: any) => entry.step?.tool === tool)?.response?.result?.content?.[0]?.text as string;

// R13-intake #1, as on 06/10: the Chief's o2 offered five fixed-row commands
// for row 190; the client typed her own request in row 190; the Monitor
// rewrote its o1 saying "Os comandos antigos para a linha 190 apagariam a
// linha dela: não rode esses" — and the o2 kept offering them. On a real
// server, the Monitor's words mark the Chief's item superseded: the panel
// says by which, and a decision on it is refused.
it("a bot's item that says another item's commands must not run supersedes that item", async () => {
  const sheet = "163U0o9RWFKqikUNsJu6T3tG1rP_3Mn3STZ1W6uYMDPQ";
  const cmd = (range: string, values: string) => `gog sheets update ${sheet} 'Atendimento!${range}' --values-json '${values}' --input RAW --account osvaldo@crmpiperun.com --no-input`;
  const session = await launchVerificationServer({ ...process.env, OMB_TEST_GRANT_PATH: GIT_DIR }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const ledger = () => JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8"));
  try {
    const chief = (await cli("new-bot", "--name", "Chief of Staff")).bot;
    const monitor = (await cli("new-bot", "--name", "Monitor Chat Atendimento")).bot;
    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [{ steps: [{ tool: "owner_pending", arguments: {
        action: "add", title: "Aprovar a criação da linha 190 da planilha (127138 do Matheus, #9384)",
        why: "A linha 189 já era a do Yuri (#9382), e os comandos aprovados iriam apagá-la. A primeira linha livre é a 190.",
        steps: [{ text: "B190", command: cmd("B190", '[["Matheus"]]') }, { text: "E190", command: cmd("E190", '[["Pendente"]]') }],
        options: [{ label: "Aprovei", reply: "Aprovei os comandos da linha 190.", recommended: true, why: "O Monitor grava e relê." }, { label: "Sem linha", reply: "Não crie linha." }],
      } }], reply: "Abri o item." }, { steps: [{ tool: "owner_pending", arguments: { action: "list" } }], reply: "Vi." },
      { expectContextIncludes: ["Aprovei, pode gravar.", "[Servidor: Superado pelo item ", "Não rode os comandos deste item"], reply: "Não gravo: o item foi superado." },
      { expectContextIncludes: ["Aprovei os comandos da linha 190."], reply: "Gravo." }] },
      [monitor.id]: { turns: [{ steps: [{ tool: "owner_pending", arguments: {
        action: "add", title: "Criar a linha 191 da planilha para a #9384 (Matheus, ticket 127138)",
        why: "A linha 190 agora é da Marluce (#9389), criada pelo Chief às 10:09. Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses. O pedido do Matheus continua sem linha.",
        steps: [{ text: "Solicitante e responsável", command: cmd("B191:C191", '[["Matheus","Osvaldo"]]') }],
      } }], reply: "Atualizei o meu item." }] },
    }));
    const turns = (botId: string) => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn: any) => turn.botId === botId)
      : [];
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Abra o item da linha 190.");
    await expect.poll(() => turns(chief.id).length, { timeout: 30_000 }).toBe(1);
    const o2 = ledger().ownerPending.find((each: any) => each.botId === chief.id);
    expect(o2.supersededBy).toBeUndefined();
    await cli("send", "--bot", monitor.id, "--task", monitor.activeTaskId, "--text", "A Marluce escreveu na linha 190.");
    await expect.poll(() => turns(monitor.id).length, { timeout: 30_000 }).toBe(1);
    expect(toolResult(turns(monitor.id)[0], "owner_pending")).toContain(`Marquei como superado, com decisões e comandos desligados: ${o2.id} do Chief of Staff.`);
    const marked = ledger().ownerPending.find((each: any) => each.botId === chief.id && each.id === o2.id);
    expect(marked.supersededBy).toMatchObject({ botId: monitor.id, botName: "Monitor Chat Atendimento", text: "Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses." });
    // the Monitor's own item, with row 191, is not touched
    expect(ledger().ownerPending.find((each: any) => each.botId === monitor.id).supersededBy).toBeUndefined();
    // the panel says by which, in the Chief's conversation
    const wire = ((await api("/api/bots", undefined, "GET")).bots.find((each: any) => each.id === chief.id).tasks ?? []).flatMap((task: any) => task.ownerPending ?? []);
    expect(wire.find((each: any) => each.id === o2.id).superseded).toMatchObject({ by: expect.stringMatching(/^o\d+ do Monitor Chat Atendimento$/), text: "Os comandos antigos para a linha 190 apagariam a linha dela: não rode esses." });
    const chips = ((await api(`/api/threads/${chief.activeTaskId}/messages`, undefined, "GET")).messages as any[]).map((message) => String(message.tool?.name ?? ""));
    expect(chips.some((chip) => chip.startsWith(`"Precisa de você": ${o2.id} superado pelo `) && chip.includes("do Monitor Chat Atendimento — decisões e comandos desligados"))).toBe(true);
    // a decision on it is refused, said why; nothing reaches the Chief
    const refused = await fetch(`${url}/api/bots/${chief.id}/owner-pending/${o2.id}/reply`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ option: 0, label: "Aprovei" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "item_superseded", error: expect.stringContaining("Não rode os comandos deste item") });
    expect(ledger().ownerPending.find((each: any) => each.id === o2.id && each.botId === chief.id).history ?? []).toEqual([]);
    // the Chief reads it in its list
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "O que está pendente?");
    await expect.poll(() => turns(chief.id).length, { timeout: 30_000 }).toBe(2);
    expect(toolResult(turns(chief.id)[1], "owner_pending")).toContain("(SUPERADO pelo ");
    // the owner's own words reach the Chief, with the item said superseded (INSP-R13fol #16)
    const words = await fetch(`${url}/api/bots/${chief.id}/owner-pending/${o2.id}/reply`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "Aprovei, pode gravar." }) });
    expect(words.status, await words.clone().text()).toBeLessThan(300);
    await expect.poll(() => turns(chief.id).length, { timeout: 30_000 }).toBe(3);
    // the owner lifts the mark: "Os comandos ainda valem" — the decision goes through again (INSP-R13fol #13)
    const lifted = await fetch(`${url}/api/bots/${chief.id}/owner-pending/${o2.id}/unsupersede`, { method: "POST", headers: { "content-type": "application/json", origin: url } });
    expect(lifted.status).toBe(200);
    expect(ledger().ownerPending.find((each: any) => each.id === o2.id && each.botId === chief.id).supersededBy).toBeUndefined();
    const again = await fetch(`${url}/api/bots/${chief.id}/owner-pending/${o2.id}/reply`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ option: 0, label: "Aprovei" }) });
    expect(again.status, await again.clone().text()).toBeLessThan(300);
    await expect.poll(() => turns(chief.id).length, { timeout: 30_000 }).toBe(4);
  } finally {
    await session.close();
  }
}, 120_000);
