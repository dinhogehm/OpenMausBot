import { describe, expect, it } from "vitest";
import { APP_UNBLOCK_CHECK_LABEL, APP_UNBLOCK_DECLINE_LABEL, appStillBlockedText, appUnblockPending, appUnblockTitle, CHIP_VISIBLE, staleUnblockItem, ownerChannelChip, plural, serverRestartedChip, sessionChips, sessionLabel } from "./owner-chips.ts";
import { batteryAlert } from "./power.ts";
import { releaseAttention, releaseAttentionAlert, releaseCausePt, releaseFailedText, releaseLoopPending } from "./release-watch.ts";

// INSP-H r1 #8: a chip shows ~55 characters (ToolActivity truncates it).
// Every chip of the lot says, in that much, what happened and what to do —
// no tool names, PIDs or statuses in English, and plurals said right.
const JARGON = /cc_session_send|cc_session_\w+|\bPID\b|\brunning\b|\bidle\b|\bstalled\b|\(s\)|\(ões\)|\(ns\)/;

describe("what the owner reads on the lot's chips", () => {
  const TITLE = "9326 gate da PR 9330";
  const attention = releaseAttention(JSON.stringify({ to: "chief", kind: "production-release-attention", reason: "fast-failure", sha: "cb015584a35296ec89b2dbaf2c54373e6f93b826", failures: 1, limit: 0, last_failure: "git@github.com: Permission denied (publickey).", at: "2026-10-02T00:30:00Z" }))!;
  const signal = releaseAttention(JSON.stringify({ to: "chief", kind: "production-release-attention", reason: "signal", sha: "cb015584a35296ec89b2dbaf2c54373e6f93b826", failures: 1, limit: 0, last_failure: "exit 143", at: "2026-10-02T00:30:00Z" }))!;
  const battery = (percent: number | null, told: string[] = []) => batteryAlert({ power: { onBattery: true, percent }, onBatterySince: 0, now: 45 * 60_000, releaseRunning: true, told: new Set(told) })!.text;
  const chips: Array<[string, string, RegExp]> = [
    ["interrupted", sessionChips.interrupted(TITLE, 2), /Sessão 9326 interrompida.*o Chief retoma/],
    ["survived", sessionChips.survived(TITLE, 2), /Sessão 9326 seguiu rodando/],
    ["followed, ended", sessionChips.followedEnded(TITLE, 2), /Sessão 9326 terminou o turno 2/],
    ["followed, cut", sessionChips.followedCut(TITLE, 2), /Sessão 9326 parou.*o Chief retoma/],
    ["survivor at the limit", sessionChips.survivorLimit(TITLE, 2, 90), /Sessão 9326 cortada no limite/],
    ["survivor stopped", sessionChips.survivorStopped(TITLE), /Sessão 9326 parada/],
    ["moved here", sessionChips.movedHere([TITLE, "9052 tempo de reabertura"], "canal do dono"), /2 sessões passam a relatar aqui/],
    ["moved here, one", sessionChips.movedHere([TITLE], "canal do dono"), /1 sessão passa a relatar aqui/],
    ["moved away", sessionChips.movedAway(TITLE), /Sessão 9326: os relatórios agora vão/],
    ["cli", sessionChips.cli(TITLE, "o app Claude está reaproveitando worktrees"), /Sessão 9326 no terminal, fora do app/],
    ["claimed", sessionChips.claimed(TITLE, [9328, 9341]), /Sessão 9326 assumiu as PRs #9328, #9341/],
    ["server restarted", serverRestartedChip({ interrupted: 1, survived: 2, rerun: 1, asked: 0 }), /Servidor reiniciado: 1 sessão interrompida \(o Chief/],
    ["release snapshot", releaseFailedText("2995ef215", 3, "Release snapshot changed during validation"), /Release 2995ef215 falhou 3× seguidas \(snapshot mudou/],
    ["owner's channel", ownerChannelChip("01/10 09:49"), /Canal do dono: esta conversa/],
    ["release loop", releaseFailedText("cb015584a", 5, "Release de producao sem alvo de runtime"), /Release cb015584a falhou 5× seguidas/],
    ["machine failure", releaseAttentionAlert(attention, { err: "e" }).text, /Release cb015584a: falha da máquina \(ssh\/git\), não do/],
    ["killed by a signal", releaseAttentionAlert(signal, { err: "e" }).text, /Release cb015584a: falha da máquina \(processo morto/],
    ["battery below the limit", battery(19), /Bateria em 19% \(seu limite: 20%\): ligue o Mac/],
    ["battery critical", battery(8, ["low"]), /Bateria em 8%, quase no fim: ligue o Mac na tomada/],
    ["no-break", battery(null), /Sem tomada \(no-break\): ligue o Mac na tomada/],
  ];

  it.each(chips)("%s: the essential in the first 55 characters, no jargon", (_name, text, essential) => {
    const visible = text.slice(0, CHIP_VISIBLE);
    expect(visible).toMatch(essential);
    expect(text).not.toMatch(JARGON);
  });

  it("opens the server's \"Precisa de você\" titles with the commit or the action (INSP-H r2 #6)", () => {
    const loop = releaseLoopPending({ short: "cb015584a", full: null, count: 5 }).title;
    expect(loop.slice(0, 40)).toBe("Recusar cb015584a (laço, 5×): copie o co");
    // the server's own title for the reused folder (askOwnerToUnblockApp)
    expect(appUnblockTitle("nuria-platform").slice(0, 40)).toMatch(/^Abrir no app uma sessão/);
    expect(releaseCausePt("ADMISSION_TIMEOUT waiting for release lease")).toBe("tempo de espera na fila esgotou");
    expect(releaseCausePt("Local CI failed at tests")).toBe("CI local falhou em tests");
  });

  it("names a session by its issue, and says plurals right", () => {
    expect(sessionLabel("#9058 Chat entra com aviso no Widget")).toBe("Sessão 9058");
    expect(sessionLabel("limpeza de worktrees antigas do repositório")).toBe("Sessão \"limpeza de worktrees an…\"");
    expect(plural(1, "sessão", "sessões")).toBe("1 sessão");
    expect(plural(3, "sessão", "sessões")).toBe("3 sessões");
    expect(serverRestartedChip({ interrupted: 0, survived: 1, rerun: 0, asked: 2 })).toBe("Servidor reiniciado: 1 sessão segue rodando, 2 turnos para confirmar");
    expect(serverRestartedChip({ interrupted: 0, survived: 0, rerun: 0, asked: 0 })).toBe("Servidor reiniciado: nada a retomar");
  });
});

// R10-dispatch R10-2: the unblock item asks the gesture that fits what the
// records show now, is rewritten in place when it does not (the legacy o8
// had only a title), and "Feito, conferir" says why when it did not work.
describe("the owner's unblock-the-app item", () => {
  it("asks root + worktree OFF for a reused folder, worktree ON when the server's session landed in the root — same answers", () => {
    const reused = appUnblockPending("nuria-platform");
    const root = appUnblockPending("nuria-platform", "root");
    expect(reused.steps.map((step) => step.text).join(" ")).toContain("deixe a worktree DESLIGADA");
    expect(reused.steps.map((step) => step.text).join(" ")).toContain("Não arquive essa sessão");
    expect(root.title).toMatch(/^Abrir no app uma sessão em nuria-platform com a worktree LIGADA/);
    expect(root.steps.map((step) => step.text).join(" ")).toContain("LIGUE a opção worktree");
    expect(root.why).toContain("mexe direto no checkout principal");
    for (const item of [reused, root]) {
      expect(item.options.map((option) => option.label)).toEqual([APP_UNBLOCK_CHECK_LABEL, APP_UNBLOCK_DECLINE_LABEL]);
      expect(item.options[0]!.recommended).toBe(true);
      expect(item.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("rewrites a legacy or out-of-date item, and leaves a current one alone", () => {
    // the real o8 of 02/10: a title, nothing else
    expect(staleUnblockItem({}, "nuria-platform", "reused")).toEqual(appUnblockPending("nuria-platform"));
    // the J item before this lot ("Depois você pode arquivar essa sessão")
    const older = { ...appUnblockPending("nuria-platform"), steps: appUnblockPending("nuria-platform").steps.map((step, i) => (i === 3 ? { text: "Pronto: … Depois você pode arquivar essa sessão." } : step)) };
    expect(staleUnblockItem(older, "nuria-platform", "reused")).not.toBeNull();
    expect(staleUnblockItem(appUnblockPending("nuria-platform"), "nuria-platform", "reused")).toBeNull();
    // asked "off", then the server's own session landed in the root: it switches
    expect(staleUnblockItem(appUnblockPending("nuria-platform"), "nuria-platform", "root")).toEqual(appUnblockPending("nuria-platform", "root"));
  });

  it("'Feito, conferir' still blocked: says what the records show and the likely slip, in pt-BR", () => {
    const reused = appStillBlockedText({ kind: "reused", last: { folder: "/r/.claude/worktrees/atendimento-reaberto-bugs-496989", title: "Aumentar usuários Piperun para 50" } }, "nuria-platform");
    expect(reused).toMatch(/^Ainda não destravou: a sessão mais recente do app \("Aumentar usuários Piperun para 50"\) está em \/r\/\.claude\/worktrees\/atendimento-reaberto-bugs-496989/);
    expect(reused).toContain("espere alguns segundos e confira de novo");
    expect(reused).toContain("refaça com ela desligada, na raiz de nuria-platform");
    const root = appStillBlockedText({ kind: "root", last: { folder: "/r", title: "9298 Regra" } }, "nuria-platform");
    expect(root).toContain("ainda é a do servidor (\"9298 Regra\"), na raiz de nuria-platform, sem worktree");
    expect(root).toContain("confira se a opção worktree estava ligada");
    expect(`${reused} ${root}`).not.toMatch(JARGON);
  });
});
