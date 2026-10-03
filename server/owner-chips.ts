// The chips the owner reads in a conversation, for what this server does on
// its own (a restart, the conversation with the owner, a release, the
// battery). A chip shows only its first ~55 characters (ToolActivity:
// max-w-[30rem] truncate), so each one opens with the essential — who, what
// happened, what to do — and leaves detail to the bot's report. No jargon
// the owner does not use (tool names, PIDs, status codes in English), and
// plurals said right (INSP-H r1 #8).

/** What a chip shows before it is cut. */
export const CHIP_VISIBLE = 55;

/** "1 sessão interrompida", "2 sessões interrompidas". */
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How a session is named on a chip: its issue number ("Sessão 9326"), else its title, short. */
export function sessionLabel(title: string): string {
  const issue = /^\s*#?(\d{3,6})(?!\d)/.exec(title)?.[1];
  if (issue) return `Sessão ${issue}`;
  const short = title.trim().replace(/\s+/g, " ");
  return `Sessão "${short.length > 24 ? `${short.slice(0, 23).trimEnd()}…` : short}"`;
}

export const sessionChips = {
  // who resumes is the Chief, not the owner reading it (INSP-H r2 #6)
  interrupted: (title: string, turn: number) => `${sessionLabel(title)} interrompida no reinício — o Chief retoma (o turno ${turn} não sobreviveu ao reinício)`,
  survived: (title: string, turn: number) => `${sessionLabel(title)} seguiu rodando no reinício — acompanho o turno ${turn} até o fim`,
  followedEnded: (title: string, turn: number) => `${sessionLabel(title)} terminou o turno ${turn}, acompanhado após o reinício`,
  followedCut: (title: string, turn: number) => `${sessionLabel(title)} parou sem fechar o turno ${turn} — o Chief retoma (o processo que sobreviveu ao reinício terminou)`,
  survivorLimit: (title: string, turn: number, minutes: number) => `${sessionLabel(title)} cortada no limite de ${minutes} min — o Chief retoma (turno ${turn}, acompanhado após o reinício)`,
  survivorStopped: (title: string) => `${sessionLabel(title)} parada: o processo que seguia após o reinício foi encerrado`,
  movedHere: (titles: string[], why: string) => `${titles.length === 1 ? "1 sessão passa" : `${titles.length} sessões passam`} a relatar aqui (${why}): ${titles.map(sessionLabel).map((label) => label.replace(/^Sessão /, "")).join(", ")}`,
  movedAway: (title: string) => `${sessionLabel(title)}: os relatórios agora vão para o canal do dono`,
  cli: (title: string, reason: string) => `${sessionLabel(title)} no terminal, fora do app: ${reason}`,
  claimed: (title: string, numbers: number[]) => `${sessionLabel(title)} assumiu ${numbers.length === 1 ? "a PR" : "as PRs"} ${numbers.map((number) => `#${number}`).join(", ")}, por ordem explícita`,
};

/** The Chief's desk after a restart: what needs doing first (sessions to resume), then the rest. */
export function serverRestartedChip(input: { interrupted: number; survived: number; rerun: number; asked: number }): string {
  const parts = [
    input.interrupted ? `${plural(input.interrupted, "sessão interrompida", "sessões interrompidas")} (o Chief retoma)` : "",
    input.survived ? `${plural(input.survived, "sessão segue", "sessões seguem")} rodando` : "",
    input.asked ? `${plural(input.asked, "turno", "turnos")} para confirmar` : "",
    input.rerun ? `${plural(input.rerun, "turno retomado", "turnos retomados")}` : "",
  ].filter(Boolean);
  return `Servidor reiniciado: ${parts.join(", ") || "nada a retomar"}`;
}

/** The owner's item while the app reuses worktrees: the action first, as it shows in two lines (INSP-H r2 #6). */
export const appUnblockTitle = (repoName: string) => `Abrir no app uma sessão na raiz de ${repoName}, com a worktree desligada, e enviar uma mensagem curta (destrava o app, que está reaproveitando worktrees; até lá as sessões vão para o terminal)`;

/** How long "seguir no terminal" holds: the server does not ask again before. */
export const APP_UNBLOCK_DECLINE_MS = 24 * 3_600_000;
export const APP_UNBLOCK_DECLINE_LABEL = "Seguir no terminal";
/** The answer the server checks before taking it: "done" while the app
 * still opens new sessions in a wrong folder is refused, and says why. */
export const APP_UNBLOCK_CHECK_LABEL = "Feito, conferir";

/** What "Feito, conferir" answers while the records still show the app
 * blocked: what the server sees, and the likely slip — the item stays
 * open, nothing goes to the bot (R10-dispatch R10-2: "fiz e não destravou"
 * had no way to be said, nor to be told). */
export function appStillBlockedText(block: { kind: "reused" | "root" | "flapping"; last: { folder: string; title?: string } }, repoName: string): string {
  const which = block.last.title ? ` ("${block.last.title}")` : "";
  if (block.kind === "flapping") return `Ainda não destravou, e não adianta repetir: o app alternou entre reaproveitar worktrees de ${repoName} e abrir sessões na raiz, e cada gesto trouxe o outro bloqueio. O servidor parou de pedir gestos; este item agora diz o que os registros mostram e o teste guiado a fazer.`;
  return block.kind === "reused"
    ? `Ainda não destravou: a sessão mais recente do app${which} está em ${block.last.folder}, uma worktree que outras sessões já usaram. Se você acabou de enviar a mensagem, espere alguns segundos e confira de novo (o app só grava a sessão depois do primeiro envio). Se a sua sessão abriu numa pasta de .claude/worktrees, a worktree estava ligada: refaça com ela desligada, na raiz de ${repoName}.`
    : `Ainda não destravou: a sessão mais recente do app ainda é a do servidor${which}, na raiz de ${repoName}, sem worktree. Se você acabou de enviar a mensagem, espere alguns segundos e confira de novo (o app só grava a sessão depois do primeiro envio). A sua sessão tem de abrir numa worktree nova: confira se a opção worktree estava ligada.`;
}

/** The owner's item to unblock the app, born practical: why it matters, the
 * steps in the Claude app, and the two answers (R10-visual N13: the server's
 * own o8 had only a title, so "Resolver" showed nothing to do). The gesture
 * is the one the app's records prove (a newest session in the repository
 * root, worktree OFF, ends the reuse), the same the 409 asks the bot for
 * (claude-desktop.ts reusedFolderRefusal); "seguir no terminal" is kept by
 * the server for 24 h, so the promise is true (INSP-J r1 #8). */
export const appUnblockPending = (repoName: string, kind: "reused" | "root" = "reused") => kind === "root" ? appWorktreeOnPending(repoName) : ({
  title: appUnblockTitle(repoName),
  why: `O app Claude está reaproveitando worktrees de ${repoName}, então o servidor não cria sessões nele: até você destravar, as sessões dos bots rodam no terminal, sem aparecer no app.`,
  steps: [
    { text: "Abra o app Claude e, no menu Arquivo, escolha Nova sessão." },
    { text: `Escolha a pasta raiz do repositório ${repoName} e deixe a worktree DESLIGADA: a sessão tem de abrir na raiz, não numa pasta de .claude/worktrees.` },
    { text: "Envie uma mensagem curta, por exemplo \"Sessão raiz do gerente OpenMausBot\", e espere a resposta: o app só grava a sessão depois do primeiro envio, e um título com palavras deixa o servidor reconhecê-la na tela." },
    { text: "Pronto: com a sessão mais nova na raiz, o servidor volta a abrir sessões no app e fecha este item sozinho. Não arquive essa sessão: o servidor parte dela para abrir as sessões novas." },
  ],
  options: [
    { label: APP_UNBLOCK_CHECK_LABEL, reply: `Abri no app uma sessão na raiz de ${repoName}, com a worktree desligada, e enviei uma mensagem. O servidor conferiu: o app voltou a aceitar sessões novas.`, recommended: true as const, why: "Leva um minuto e as sessões dos bots voltam a aparecer no app, onde você as acompanha." },
    { label: APP_UNBLOCK_DECLINE_LABEL, reply: `Não vou destravar o app agora: siga com as sessões de ${repoName} no terminal. O servidor não me pede isso de novo nas próximas 24 h.` },
  ],
});

/** The same item when the server's own last session landed in the root,
 * without a worktree (claude-desktop.ts lastServerSessionInRoot): New
 * Session comes with the worktree off — after the gesture above, maybe —
 * and the remedy is the opposite switch. Same key, so the one item changes
 * to what is true now. */
const appWorktreeOnPending = (repoName: string) => ({
  title: `Abrir no app uma sessão em ${repoName} com a worktree LIGADA e enviar uma mensagem curta (a última sessão do servidor caiu na raiz, sem worktree; até lá as sessões vão para o terminal)`,
  why: `A última sessão que o servidor abriu no app caiu na raiz de ${repoName}, sem worktree própria: o app está abrindo sessões novas com a worktree desligada, e uma sessão assim mexe direto no checkout principal. Até você religar, as sessões dos bots rodam no terminal, sem aparecer no app.`,
  steps: [
    { text: "Abra o app Claude e, no menu Arquivo, escolha Nova sessão." },
    { text: `Escolha a pasta ${repoName} e LIGUE a opção worktree.` },
    { text: "Envie uma mensagem curta, por exemplo \"ok\", e espere a resposta: o app só grava a sessão depois do primeiro envio." },
    { text: "Pronto: quando ela abrir numa worktree nova, o servidor volta a abrir sessões no app e fecha este item sozinho. Se ela cair numa worktree que já existia, este item troca para o gesto que resolve isso." },
  ],
  options: [
    { label: APP_UNBLOCK_CHECK_LABEL, reply: `Abri no app uma sessão em ${repoName} com a worktree ligada e enviei uma mensagem. O servidor conferiu: o app voltou a aceitar sessões novas.`, recommended: true as const, why: "Leva um minuto e as sessões dos bots voltam a aparecer no app, onde você as acompanha." },
    { label: APP_UNBLOCK_DECLINE_LABEL, reply: `Não vou destravar o app agora: siga com as sessões de ${repoName} no terminal. O servidor não me pede isso de novo nas próximas 24 h.` },
  ],
});

/** An open unblock item while the app is still not free: the item it
 * should be now, or null when it already asks the gesture that fits
 * `kind` (R10-dispatch R10-2: the legacy o8 had only a title). */
export function staleUnblockItem(item: { why?: string; steps?: ReadonlyArray<{ text: string }> }, repoName: string, kind: "reused" | "root" | "flapping", seen: readonly FolderBlockSeen[] = []): ReturnType<typeof appUnblockPending> | null {
  const want = kind === "flapping" ? appFlappingPending(repoName, seen) : appUnblockPending(repoName, kind);
  const said = (steps: ReadonlyArray<{ text: string }> | undefined) => (steps ?? []).map((step) => step.text).join("\n");
  return item.why === want.why && said(item.steps) === said(want.steps) ? null : want;
}

// ── the app flapping between the two blocks ────────────────────────────

/** A block of the app's folder as the server saw it (claude-desktop.ts
 * lastAppWorktreeFolder: "reused"; lastServerSessionInRoot: "root"). */
export interface FolderBlockSeen { kind: "reused" | "root"; at: number; folder: string; title?: string }
/** The blocks seen lately, and when the server stopped asking gestures. */
export interface FolderFlapState { seen: FolderBlockSeen[]; stoppedAt?: number }

/** Switches between the two blocks that stop the gestures: the 2nd one is a
 * round trip (reused → root → reused): each gesture asked brought back the
 * other block, so a third gesture is not asked (INSP-S r1 S-3). */
export const FOLDER_FLIPS_TO_STOP = 2;
/** Blocks older than this are forgotten: a flip a week apart is no loop. */
export const FOLDER_FLAP_WINDOW_MS = 7 * 24 * 3_600_000;

/** How many times the block switched kind in `seen`. */
export const folderFlips = (seen: readonly FolderBlockSeen[]) => seen.reduce((flips, each, index) => flips + (index > 0 && seen[index - 1]!.kind !== each.kind ? 1 : 0), 0);

/** The state after the server saw `block` (null: the app is free) at `at`.
 * Only a change of kind is kept; at FOLDER_FLIPS_TO_STOP switches it stops
 * (sticky, until the owner answers the item it opens). */
export function noteFolderBlock(state: FolderFlapState, block: Omit<FolderBlockSeen, "at"> | null, at: number): FolderFlapState {
  if (state.stoppedAt !== undefined || !block) return state;
  const seen = state.seen.filter((each) => at - each.at < FOLDER_FLAP_WINDOW_MS);
  if (seen.at(-1)?.kind === block.kind) return seen.length === state.seen.length ? state : { seen };
  const next = [...seen, { kind: block.kind, at, folder: block.folder, ...(block.title ? { title: block.title } : {}) }].slice(-6);
  return folderFlips(next) >= FOLDER_FLIPS_TO_STOP ? { seen: next, stoppedAt: at } : { seen: next };
}

const brt = (at: number) => new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const blockPt = (each: FolderBlockSeen) => each.kind === "reused"
  ? `${brt(each.at)}: a sessão${each.title ? ` "${each.title}"` : ""} caiu numa worktree que outras já usavam (${each.folder}), pede raiz com a worktree desligada`
  : `${brt(each.at)}: a sessão do servidor${each.title ? ` "${each.title}"` : ""} caiu na raiz, sem worktree (${each.folder}), pede a worktree ligada`;

/** What the server answers the 409 with once it stopped asking gestures. */
export function flappingRefusal(seen: readonly FolderBlockSeen[], repoName: string, fromQueue = false): string {
  return [
    `não abri: o app Claude alternou ${folderFlips(seen)} vezes entre reaproveitar worktrees de ${repoName} e abrir sessões na raiz, sem worktree — cada gesto pedido ao dono trouxe o outro bloqueio. O servidor parou de pedir gestos: o app não está abrindo sessões em pasta própria de forma confiável.`,
    `O dono já tem um item único em "Precisa de você" com o diagnóstico e o teste guiado; não peça gesto nenhum a ele nem abra outro item. Use surface "cli" com cli_reason "app alternando pasta" até ele responder.`,
    ...(fromQueue ? [`Este pedido veio da fila de sessões e continua nela; para não esperar, abra-o no terminal.`] : []),
  ].join(" ");
}

/** The answer to the item once the owner ran the guided test: the count
 * starts over and the server looks at the app's records again. */
export const APP_FLAPPING_CHECK_LABEL = "Rodei o teste, conferir";

/** The ONE item the owner gets once the app flapped (INSP-S r1 S-3): the
 * diagnosis with what each block was and when, and what to do — no third
 * gesture. Same key as the unblock item, so it replaces it in place. */
export function appFlappingPending(repoName: string, seen: readonly FolderBlockSeen[]) {
  return {
    title: `O app Claude alterna entre reaproveitar worktree e cair na raiz: as sessões de ${repoName} seguem no terminal até você rodar o teste guiado`,
    why: [
      `O servidor parou de pedir gestos de destravar: cada um trouxe o outro bloqueio (${folderFlips(seen)} trocas).`,
      ...seen.map(blockPt),
      `Diagnóstico: o app não está abrindo sessões em pasta própria de forma confiável, e mais um gesto só repete a troca. Até o teste guiado mostrar como o app escolhe a pasta de uma sessão nova, as sessões dos bots rodam no terminal, sem aparecer no app; nada se perde.`,
    ].join("\n"),
    steps: [
      { text: "Não refaça os gestos de destravar (raiz com a worktree desligada, ou worktree ligada): cada um reproduziu o outro bloqueio." },
      { text: "Quando tiver 10 a 15 minutos, rode o teste guiado do app (Roteiro S, em ~/nuria-ops/audit/ROTEIRO-S.md): ele mostra, com capturas, de onde o app tira a pasta de uma sessão nova." },
      { text: `Depois, responda "${APP_FLAPPING_CHECK_LABEL}": o servidor zera esta contagem e confere os registros do app. Se o app estiver livre, as sessões voltam para ele; se não, este item volta a dizer o que os registros mostram.` },
    ],
    options: [
      { label: APP_FLAPPING_CHECK_LABEL, reply: `Rodei o teste guiado do app (Roteiro S). Pode voltar a tentar abrir as sessões de ${repoName} no app; o servidor confere os registros antes.`, recommended: true as const, why: "Só o teste no app real diz de onde ele tira a pasta; sem isso, cada gesto é um palpite." },
      { label: APP_UNBLOCK_DECLINE_LABEL, reply: `Siga com as sessões de ${repoName} no terminal. O servidor não me pede isso de novo nas próximas 24 h.` },
    ],
  };
}

/** The conversation with the owner, read back from their order. */
export const ownerChannelChip = (when: string) => `Canal do dono: esta conversa (ordem de ${when}) — avisos, relatórios e pendências vêm para cá`;
