import { describe, expect, it } from "vitest";
import { APP_FLAPPING_CHECK_LABEL, APP_UNBLOCK_CHECK_LABEL, APP_UNBLOCK_DECLINE_LABEL, appFlappingPending, appStillBlockedText, appUnblockPending, appUnblockTitle, CHIP_VISIBLE, FOLDER_FLAP_WINDOW_MS, FOLDER_FLIPS_TO_STOP, FOLDER_STOP_FREE_MS, FOLDER_STOP_MAX_MS, folderFlips, type FolderFlapState, flappingRefusal, noteFolderBlock, staleUnblockItem, ownerChannelChip, plural, serverRestartedChip, sessionChips, sessionLabel } from "./owner-chips.ts";
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
describe("the old way's items where the server makes the worktrees (R12-1)", () => {
  it("never ask to turn the worktree option on: the server's path needs it OFF, and the breaker's item is what ends it", () => {
    const item = appUnblockPending("nuria-platform", "root", true);
    const text = [item.title, item.why, ...item.steps.map((step) => step.text), ...item.options.map((option) => option.reply)].join("\n");
    // an order to turn it on, anywhere ("Não ligue a opção" is the opposite and allowed)
    expect(text).not.toMatch(/LIGUE|LIGAR|com a worktree ligada|(?<!Não )ligue a opção/);
    expect(text).toContain("Não ligue a opção");
    expect(item.title).toContain("Deixe a opção worktree DESLIGADA");
    expect(item.steps.map((step) => step.text).join(" ")).toContain('resolva o item "O app Claude abriu … sessões de nuria-platform …"');
    const still = appStillBlockedText({ kind: "root", last: { folder: "/r/nuria-platform", title: "9311 x" } }, "nuria-platform", true);
    expect(still).toContain("Não ligue a opção");
    expect(still).not.toMatch(/estava ligada/);
    // the item of the old gesture is rewritten to this one in place
    expect(staleUnblockItem(appUnblockPending("nuria-platform", "root"), "nuria-platform", "root", [], true)).toEqual(item);
    expect(staleUnblockItem(item, "nuria-platform", "root", [], true)).toBeNull();
    // without the server's worktrees, the old remedy is unchanged
    expect(appUnblockPending("nuria-platform", "root").steps.map((step) => step.text).join(" ")).toContain("LIGUE a opção worktree");
  });
});

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

// INSP-S r1 S-3: "raiz + worktree desligada" and "worktree LIGADA" can each
// bring the other block back. On the 2nd switch the server stops asking
// gestures and gives the owner ONE item with the diagnosis and what to do.
describe("the app flapping between the two blocks", () => {
  const H = 3_600_000;
  const T0 = Date.parse("2026-10-02T13:07:29Z");
  const F = "/r/.claude/worktrees/atendimento-reaberto-bugs-496989";
  const reused = { kind: "reused" as const, folder: F, title: "Aumentar usuários Piperun para 50" };
  const rooted = { kind: "root" as const, folder: "/r", title: "9311 Chat no ticket" };

  it("stops on the 2nd switch (reused → root → reused), not on a repeat of the same block or the app being free", () => {
    let state: FolderFlapState = { seen: [] };
    state = noteFolderBlock(state, reused, T0);
    state = noteFolderBlock(state, reused, T0 + 60_000); // the same block, asked again: no switch
    state = noteFolderBlock(state, null, T0 + 0.5 * H); // the owner's gesture freed it
    expect(state).toEqual({ seen: [{ ...reused, at: T0 }], freeSince: T0 + 0.5 * H });
    state = noteFolderBlock(state, rooted, T0 + H); // the next create fell in the root: 1st switch
    expect(folderFlips(state.seen)).toBe(1);
    expect(state.stoppedAt).toBeUndefined();
    state = noteFolderBlock(state, null, T0 + 1.5 * H); // "worktree LIGADA" freed it
    state = noteFolderBlock(state, reused, T0 + 2 * H); // …and landed in a reused folder: 2nd switch
    expect(folderFlips(state.seen)).toBe(FOLDER_FLIPS_TO_STOP);
    expect(state.stoppedAt).toBe(T0 + 2 * H);
    // held while the app keeps blocking, or is free only briefly
    expect(noteFolderBlock(state, rooted, T0 + 3 * H)).toBe(state);
    const brief = noteFolderBlock(state, null, T0 + 3 * H);
    expect(brief.stoppedAt).toBe(T0 + 2 * H);
    expect(noteFolderBlock(brief, null, T0 + 3 * H + FOLDER_STOP_FREE_MS - 1).stoppedAt).toBe(T0 + 2 * H);
  });

  // INSP-S r2 S2-2: Monday a reuse, Thursday a root, Saturday a reuse —
  // each fixed by its gesture, the app working in between: no loop
  it("three independent incidents in a week, the app working between them, stop nothing", () => {
    const D = 24 * H;
    // with creates of ours that worked in between
    let state: FolderFlapState = { seen: [] };
    state = noteFolderBlock(state, reused, T0);
    state = noteFolderBlock(state, null, T0 + 0.5 * H);
    state = noteFolderBlock(state, rooted, T0 + 3 * D, T0 + D); // a create worked on Tuesday
    state = noteFolderBlock(state, null, T0 + 3 * D + H, T0 + D);
    state = noteFolderBlock(state, reused, T0 + 5 * D, T0 + 4 * D); // and on Friday
    expect(state.stoppedAt).toBeUndefined();
    expect(folderFlips(state.seen)).toBe(0);
    // with no create at all, but the app free for days between them
    let quiet: FolderFlapState = { seen: [] };
    quiet = noteFolderBlock(quiet, reused, T0);
    quiet = noteFolderBlock(quiet, null, T0 + H);
    quiet = noteFolderBlock(quiet, rooted, T0 + 3 * D);
    quiet = noteFolderBlock(quiet, null, T0 + 3 * D + H);
    quiet = noteFolderBlock(quiet, reused, T0 + 5 * D);
    expect(quiet.stoppedAt).toBeUndefined();
    // a create that worked between two switches in the same hour breaks the chain too
    let quick: FolderFlapState = { seen: [] };
    quick = noteFolderBlock(quick, reused, T0);
    quick = noteFolderBlock(quick, rooted, T0 + H);
    quick = noteFolderBlock(quick, reused, T0 + 2 * H, T0 + 1.5 * H);
    expect(quick.stoppedAt).toBeUndefined();
    expect(quick.seen).toEqual([{ ...reused, at: T0 + 2 * H }]);
  });

  it("the stop is never for good: it ends when the app stays free a day, a create works, or after 3 days", () => {
    let stopped: FolderFlapState = { seen: [] };
    for (const [block, hours] of [[reused, 0], [rooted, 1], [reused, 2]] as const) stopped = noteFolderBlock(stopped, block, T0 + hours * H);
    expect(stopped.stoppedAt).toBe(T0 + 2 * H);
    // free for 24 h
    const free = noteFolderBlock(stopped, null, T0 + 3 * H);
    expect(noteFolderBlock(free, null, T0 + 3 * H + FOLDER_STOP_FREE_MS)).toEqual({ seen: [] });
    // a block in the middle restarts the free clock
    const again = noteFolderBlock(noteFolderBlock(free, rooted, T0 + 10 * H), null, T0 + 11 * H);
    expect(noteFolderBlock(again, null, T0 + 3 * H + FOLDER_STOP_FREE_MS).stoppedAt).toBe(T0 + 2 * H);
    // a create of ours that worked after the stop
    expect(noteFolderBlock(stopped, null, T0 + 4 * H, T0 + 3 * H)).toEqual({ seen: [] });
    // 3 days, whatever the app does: re-evaluated from zero (the block now is a plain one, its gesture asked)
    expect(noteFolderBlock(stopped, rooted, T0 + 2 * H + FOLDER_STOP_MAX_MS)).toEqual({ seen: [{ ...rooted, at: T0 + 2 * H + FOLDER_STOP_MAX_MS }] });
  });

  it("forgets blocks a week old: a switch that far apart is no loop", () => {
    let state: FolderFlapState = { seen: [] };
    state = noteFolderBlock(state, reused, T0);
    state = noteFolderBlock(state, rooted, T0 + H);
    state = noteFolderBlock(state, reused, T0 + FOLDER_FLAP_WINDOW_MS + 2 * H);
    expect(state.stoppedAt).toBeUndefined();
    expect(state.seen.map((each) => each.kind)).toEqual(["reused"]);
  });

  it("gives ONE honest item: no third gesture, the diagnosis with each block, the guided test, the two answers", () => {
    let state: FolderFlapState = { seen: [] };
    for (const [block, hours] of [[reused, 0], [rooted, 1], [reused, 2]] as const) state = noteFolderBlock(state, block, T0 + hours * H);
    const item = appFlappingPending("nuria-platform", state.seen);
    expect(item.title).toBe("O app Claude alterna entre reaproveitar worktree e cair na raiz: as sessões de nuria-platform seguem no terminal até você rodar o teste guiado");
    expect(item.why.split("\n")).toEqual([
      "O servidor parou de pedir gestos de destravar: cada um trouxe o outro bloqueio (2 trocas).",
      `02/10, 10:07: a sessão "Aumentar usuários Piperun para 50" caiu numa worktree que outras já usavam (${F}), pede raiz com a worktree desligada`,
      "02/10, 11:07: a sessão do servidor \"9311 Chat no ticket\" caiu na raiz, sem worktree (/r), pede a worktree ligada",
      `02/10, 12:07: a sessão "Aumentar usuários Piperun para 50" caiu numa worktree que outras já usavam (${F}), pede raiz com a worktree desligada`,
      expect.stringContaining("Diagnóstico: o app não está abrindo sessões em pasta própria de forma confiável"),
    ]);
    const steps = item.steps.map((step) => step.text).join(" ");
    expect(steps).toContain("Não refaça os gestos de destravar");
    expect(steps).toContain("ROTEIRO-S.md");
    expect(steps).not.toMatch(/LIGUE a opção|deixe a worktree DESLIGADA/);
    expect(item.options.map((option) => option.label)).toEqual([APP_FLAPPING_CHECK_LABEL, APP_UNBLOCK_DECLINE_LABEL]);
    // the open unblock item becomes this one, in place
    expect(staleUnblockItem(appUnblockPending("nuria-platform", "root"), "nuria-platform", "flapping", state.seen)).toEqual(item);
    expect(staleUnblockItem(item, "nuria-platform", "flapping", state.seen)).toBeNull();
    // the bot is told not to ask any gesture, and where to go
    const refusal = flappingRefusal(state.seen, "nuria-platform");
    expect(refusal).toContain("alternou 2 vezes");
    expect(refusal).toContain("não peça gesto nenhum a ele nem abra outro item");
    expect(refusal).toContain('surface "cli"');
    expect(appStillBlockedText({ kind: "flapping", last: { folder: F } }, "nuria-platform")).toContain("O servidor parou de pedir gestos");
    expect(`${item.title} ${item.why} ${steps}`).not.toMatch(JARGON);
  });
});
