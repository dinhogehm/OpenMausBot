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

/** The owner's item to unblock the app, born practical: why it matters, the
 * steps in the Claude app, and the two answers (R10-visual N13: the server's
 * own o8 had only a title, so "Resolver" showed nothing to do). The gesture
 * is the one the app's records prove (a newest session in the repository
 * root, worktree OFF, ends the reuse), the same the 409 asks the bot for
 * (claude-desktop.ts reusedFolderRefusal); "seguir no terminal" is kept by
 * the server for 24 h, so the promise is true (INSP-J r1 #8). */
export const appUnblockPending = (repoName: string) => ({
  title: appUnblockTitle(repoName),
  why: `O app Claude está reaproveitando worktrees de ${repoName}, então o servidor não cria sessões nele: até você destravar, as sessões dos bots rodam no terminal, sem aparecer no app.`,
  steps: [
    { text: "Abra o app Claude e, no menu Arquivo, escolha Nova sessão." },
    { text: `Escolha a pasta raiz do repositório ${repoName} e deixe a worktree DESLIGADA: a sessão tem de abrir na raiz, não numa pasta de .claude/worktrees.` },
    { text: "Envie uma mensagem curta, por exemplo \"ok\", e espere a resposta: o app só grava a sessão depois do primeiro envio." },
    { text: "Pronto: com a sessão mais nova na raiz, o servidor volta a abrir sessões no app e fecha este item sozinho. Depois você pode arquivar essa sessão." },
  ],
  options: [
    { label: "Feito, conferir", reply: `Abri no app uma sessão na raiz de ${repoName}, com a worktree desligada, e enviei uma mensagem. Confira se o app voltou a aceitar sessões novas.`, recommended: true as const, why: "Leva um minuto e as sessões dos bots voltam a aparecer no app, onde você as acompanha." },
    { label: APP_UNBLOCK_DECLINE_LABEL, reply: `Não vou destravar o app agora: siga com as sessões de ${repoName} no terminal. O servidor não me pede isso de novo nas próximas 24 h.` },
  ],
});

/** The conversation with the owner, read back from their order. */
export const ownerChannelChip = (when: string) => `Canal do dono: esta conversa (ordem de ${when}) — avisos, relatórios e pendências vêm para cá`;
