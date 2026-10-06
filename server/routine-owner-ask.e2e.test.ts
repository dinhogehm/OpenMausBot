import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// R12-visual N22, as on 05/10 09:00: the Monitor's hourly routine ended with
// "A conversa do widget (Nuria.identify) continua com você: às 8:39 você
// disse que ia falar direto com o Luis Rossi." and nothing showed it. A real
// server running the routine three times opens ONE item; the bot saying it
// is resolved closes it; the owner's answer closes the next one.
it("a routine that leaves something with the owner opens one item, refreshed by the repetition, closed by the bot or the owner", async () => {
  const ask = "Passada das 10h sem novidade. Não postei nada no Chat.\n\n- **Chat:** a mensagem mais recente ainda é a do Filipe Migon às 8:58, \"Top, corrigido o problema então\". A conversa do widget (Nuria.identify) continua com você: às 8:39 você disse que ia falar direto com o Luis Rossi.";
  const reworded = "Passada das 11h sem novidade. A conversa do widget com o Luis Rossi continua com você.";
  const replies = [
    // an English line between tool calls becomes a work note: never an item (R12-followup #4)
    ["Still waiting on you for the Luis Rossi widget thread.", "Passada sem novidade. Não postei nada."],
    ask, reworded, ask,
    "Respondi ao Luis Rossi no widget; a conversa está resolvida.",
    ask,
    "Anotado: vou conferir qual é a conversa do widget.",
    "Anotado.",
    ask,
  ];
  const state = join(tmpdir(), `omb-routine-ask-replies-${process.pid}-${Date.now()}`);
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(replies), FAKE_CLAUDE_REPLY_STATE: state });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json() as Promise<any>;
  };
  const ledger = () => (existsSync(join(dataDir, "bot-autonomy.json")) ? JSON.parse(readFileSync(join(dataDir, "bot-autonomy.json"), "utf8")) : {});
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Monitor Chat Atendimento", "--url", url]) as any;
    const { routine } = await api("POST", "/api/routines", {
      name: "Atendimento: Chat, planilha e issues", prompt: "Confira o Chat, a planilha e as issues.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const runOnce = async () => {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((each: any) => each.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await api("GET", "/api/routines")).runs.find((each: any) => each.id === run.id);
    };
    const chips = async (threadId: string, start: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[])
      .filter((message) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith(start));

    await runOnce();
    expect(ledger().ownerPending ?? []).toEqual([]);

    // three runs, one item
    const first = await runOnce();
    await expect.poll(() => (ledger().ownerPending ?? []).length, { timeout: 10_000 }).toBe(1);
    const [item] = ledger().ownerPending;
    expect(item).toMatchObject({ botId: bot.id, threadId: first.resultsThreadId, key: "routine-ask:conversa:widget", title: "Responder ao Luis Rossi (widget)" });
    expect(item.why).toContain("na rotina \"Atendimento: Chat, planilha e issues\", escreveu: \"A conversa do widget (Nuria.identify) continua com você");
    expect(item.steps).toHaveLength(3);
    await runOnce();
    await runOnce();
    expect(ledger().ownerPending.map((each: any) => each.id)).toEqual([item.id]);
    // one chip, one notice: the repetitions said nothing new
    expect(await chips(first.resultsThreadId, `Em "Precisa de você" (${item.id})`)).toHaveLength(1);

    // the bot says, in its conversation, that it is resolved: the item closes
    await runControlOmb(["send", "--bot", bot.id, "--text", "E o Luis Rossi?", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    await expect.poll(() => (ledger().ownerPending ?? []).length, { timeout: 10_000 }).toBe(0);
    expect(ledger().resolvedOwnerPending.find((each: any) => each.id === item.id)).toMatchObject({ resolvedBy: "bot", resolvedNote: "o bot disse que resolveu" });
    expect(await chips(item.threadId, `"Precisa de você": ${item.id} fechado`)).toHaveLength(1);

    // said again later: a new item, never the settled id
    await runOnce();
    await expect.poll(() => (ledger().ownerPending ?? []).length, { timeout: 10_000 }).toBe(1);
    const [next] = ledger().ownerPending;
    expect(next.id).not.toBe(item.id);
    // a question of the owner goes to the bot and keeps the item open (INSP-N22 A3)
    const asked = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${next.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "Qual widget? Não entendi" }),
    });
    expect(asked.status, await asked.clone().text()).toBeLessThan(300);
    expect(await asked.json()).toMatchObject({ resolved: 0 });
    expect(ledger().ownerPending.map((each: any) => each.id)).toEqual([next.id]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    // the owner answers it in words that end it: it closes, and the bot hears the answer
    const answered = await fetch(`${url}/api/bots/${bot.id}/owner-pending/${next.id}/reply`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ text: "Já falei com ele por telefone." }),
    });
    expect(answered.status, await answered.clone().text()).toBeLessThan(300);
    expect(await answered.json()).toMatchObject({ resolved: 1 });
    expect(ledger().ownerPending ?? []).toEqual([]);
    expect(ledger().resolvedOwnerPending.find((each: any) => each.id === next.id)).toMatchObject({ resolvedBy: "owner" });
    expect(await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    // the routine repeating what it read before does not reopen it
    await runOnce();
    expect(ledger().ownerPending ?? []).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(state, { force: true });
  }
}, 120_000);
