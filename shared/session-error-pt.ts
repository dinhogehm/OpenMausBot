// A Claude Code session's lastError, as the person reads it: in pt-BR. The
// server records it in English (the bots read it as machine text); the
// sidebar tooltip and the chips show this reading. Unknown errors pass
// through unchanged.

const KNOWN: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  // the app failed and the cli took over (R13-dispatch, INSP-R13dis 6): said first, it is what matters now
  [/(Both ways of the Claude app failed|The Claude app did not open the session in the right folder), so the server started the same brief in the CLI as session (\S+?);/, (m) => `${m[1]!.startsWith("Both") ? "os dois caminhos do app falharam" : "o app não abriu na pasta certa"}; segui pela linha de comando (sessão ${m[2]!.slice(0, 8)})`],
  [/(Both ways of the Claude app failed|The Claude app did not open the session in the right folder), so the server put the same brief in the session queue for the CLI/, (m) => `${m[1]!.startsWith("Both") ? "os dois caminhos do app falharam" : "o app não abriu na pasta certa"}; a mesma tarefa entrou na fila da linha de comando`],
  [/(Both ways of the Claude app failed|The Claude app did not open the session in the right folder), and the server could not start the same brief in the CLI: (.+)$/, (m) => `${m[1]!.startsWith("Both") ? "os dois caminhos do app falharam" : "o app não abriu na pasta certa"}, e a linha de comando recusou a mesma tarefa: ${m[2]}`],
  [/the app did not open the session in the worktree the server made.*New Session failed too/i, () => "o app não abriu a sessão na worktree do OpenMausBot, e a sessão nova pelo jeito antigo também falhou"],
  [/New Session, the old way, would land in a wrong folder/i, () => "o app não abriu a sessão na worktree do OpenMausBot, e a sessão nova pelo jeito antigo cairia numa pasta errada"],
  [/the app did not open the session in the worktree the server made: the new session shows another folder in its chips/i, () => "o app abriu a sessão nova na pasta anterior, não na worktree do OpenMausBot"],
  [/the app did not open the session in the worktree the server made: the new session's folder chip is cut short to a start that another worktree/i, () => "o app mostrou um nome de pasta cortado que serve para mais de uma worktree; não dá para saber se é a do OpenMausBot"],
  [/the app did not open the session in the worktree the server made: the app asks to trust the workspace .* again after the server clicked it once/i, () => "o app pediu de novo para confiar no workspace depois do clique do servidor"],
  [/the app did not open the session in the worktree the server made: the new session shows a scratch folder/i, () => "o app levou a sessão nova para uma pasta de rascunho (scratch) depois do clique em Confiar"],
  [/the app did not open the session in the worktree the server made/i, () => "o app não abriu a sessão na worktree do OpenMausBot"],
  [/New Session did not show a new session's screen/i, () => "o app não mostrou a tela de sessão nova (apareceu uma conversa)"],
  [/could not send the message after (\d+) tries/i, (m) => `não foi possível enviar a mensagem depois de ${m[1]} tentativas`],
  [/a message was typed into the Claude app (\d+) times but never reached the session/i, (m) => `uma mensagem foi digitada no app Claude ${m[1]} vezes e nunca chegou à sessão`],
  [/the turn ran past (\d+) minutes and was stopped/i, (m) => `o turno passou de ${m[1]} minutos e foi parado`],
  [/the server restarted .*while this turn was running/i, () => "o servidor reiniciou durante o turno; retome com cc_session_send"],
  [/it never answered its brief/i, () => "a sessão nunca respondeu ao brief"],
  [/its last turn ended and it never moved again/i, () => "o último turno terminou e a sessão não se mexeu mais"],
  [/opened outside a git worktree.*told it to check its folder first/i, () => "a sessão abriu na raiz, sem worktree (o app estava com a worktree desligada); o brief a mandou parar sem mexer em nada — confira no app"],
  [/opened in (.+?) instead of a new worktree.*told it to check its folder first/i, () => "a sessão abriu numa worktree de outra sessão; o brief a mandou parar sem mexer em nada — confira no app"],
  [/opened outside a git worktree/i, () => "a sessão abriu fora de uma worktree — confira no app e pare-a se preciso"],
  [/opened in (.+?) instead of a new worktree/i, () => "a sessão abriu numa worktree que não é dela — pare-a no app e recomece"],
  [/stopped at its folder check/i, () => "a sessão parou no passo 0: abriu numa pasta que já existia (worktree reaproveitada ou raiz) e não mexeu em nada"],
  [/the brief was sent, but no matching session appeared/i, () => "o brief foi enviado, mas a sessão não apareceu no app em 5 minutos"],
  [/the session never opened in the Claude app/i, () => "a sessão nunca abriu no app Claude"],
  [/could not open the session after (\d+) tries/i, (m) => `não foi possível abrir a sessão depois de ${m[1]} tentativas`],
  [/the Mac was never idle and unlocked for long enough/i, () => "o Mac não ficou ocioso e desbloqueado tempo suficiente em 12 horas"],
  [/could not (send the message|archive the session|rename the session) in the Claude app/i, (m) => `não foi possível ${m[1] === "send the message" ? "enviar a mensagem" : m[1] === "archive the session" ? "arquivar a sessão" : "renomear a sessão"} no app Claude`],
  [/could not start claude/i, () => "não foi possível iniciar o claude"],
];

/** The pt-BR reading of a session error: the known start, then the original detail. */
export function sessionErrorPt(error: string): string {
  for (const [pattern, say] of KNOWN) {
    const match = pattern.exec(error);
    if (match) return say(match);
  }
  return error;
}
