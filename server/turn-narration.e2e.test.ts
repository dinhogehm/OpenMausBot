import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// R12-followup #4, as on 05/10 08:22 in the owner's channel: the Chief's turn
// wrote an English line between its tool calls, then its reply in Portuguese.
// Both landed as text to the owner. Now the English line, once the turn ends
// with a Portuguese reply, is a work note (activity); the reply stays text.
it("an English line before a Portuguese reply ends the turn as a work note, not as a message to the owner", async () => {
  const narration = "Both nested ones are clean and published; remove them (routine). The merge-deploy one has untracked `.claude/` config and closed-unmerged PR — leave.";
  const reply = "Osvaldo, das três worktrees que estavam paradas havia mais de 72 horas fora da tag, removi duas e deixei uma para você decidir.";
  // the counter keeps the replies' order across the engine's fresh processes
  const state = join(tmpdir(), `omb-narration-replies-${process.pid}-${Date.now()}`);
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([[narration, reply], ["Let me check.", "The gate is green."]]), FAKE_CLAUDE_REPLY_STATE: state });
  const { url } = fixture.info;
  const api = (path: string) => request(path, {}, url) as Promise<any>;
  try {
    const chief = (await runControlOmb(["new-bot", "--name", "Chief of Staff", "--url", url]) as any).bot;
    await runControlOmb(["send", "--bot", chief.id, "--text", "Rotina de disco", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", chief.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const threadId = ((await api("/api/bots?messages=0")).bots as any[]).find((bot) => bot.id === chief.id).threadId as string;
    const messages = (await api(`/api/threads/${threadId}/messages`)).messages as any[];
    // the turns' texts (the bot's greeting has no turn)
    const texts = messages.filter((message) => message.role === "bot" && message.kind === "text" && message.turnId).map((message) => message.text);
    expect(texts).toEqual([reply]);
    const note = messages.find((message) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("Nota de trabalho do bot, em inglês"));
    expect(note?.tool?.name).toContain("Both nested ones are clean and published");
    expect(note?.text).toBeUndefined();
    // a turn answered in English (the person wrote in English): nothing is hidden
    await runControlOmb(["send", "--bot", chief.id, "--text", "Is the gate green?", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", chief.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const after = ((await api(`/api/threads/${threadId}/messages`)).messages as any[])
      .filter((message) => message.role === "bot" && message.kind === "text" && message.turnId).map((message) => message.text);
    expect(after).toEqual([reply, "Let me check.", "The gate is green."]);
  } finally {
    await fixture.close();
    rmSync(state, { force: true });
  }
}, 90_000);
