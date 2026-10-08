import { describe, expect, it } from "vitest";
import { sessionErrorPt } from "./session-error-pt.ts";

describe("a session's error in pt-BR", () => {
  it("reads the known ones in Portuguese and leaves the rest", () => {
    expect(sessionErrorPt("could not send the message after 5 tries with the screen unlocked")).toBe("não foi possível enviar a mensagem depois de 5 tentativas");
    expect(sessionErrorPt("the turn ran past 90 minutes and was stopped")).toBe("o turno passou de 90 minutos e foi parado");
    expect(sessionErrorPt("could not archive the session in the Claude app: busy")).toBe("não foi possível arquivar a sessão no app Claude");
    expect(sessionErrorPt("something new")).toBe("something new");
  });

  // INSP-R13dis 6: every new reason of the app's own path and of the cli taking over, in pt-BR
  it("reads the app's own-folder reasons and says when the cli took over", () => {
    const own = "the app did not open the session in the worktree the server made";
    const cases: Array<[string, string]> = [
      [`${own}: the new session shows another folder in its chips (the folder before), not x; nothing was clicked or typed. The Claude app did not open the session in the right folder, so the server started the same brief in the CLI as session c11a0000-0000-4000-8000-000000000000; its report comes here. Do not start it again`, "o app não abriu na pasta certa; segui pela linha de comando (sessão c11a0000)"],
      [`${own} (no empty task field), and then New Session failed too: x. Both ways of the Claude app failed, so the server started the same brief in the CLI as session abcdef12-1; its report comes here.`, "os dois caminhos do app falharam; segui pela linha de comando (sessão abcdef12)"],
      [`x. Both ways of the Claude app failed, so the server put the same brief in the session queue for the CLI (q1); it opens by itself.`, "os dois caminhos do app falharam; a mesma tarefa entrou na fila da linha de comando"],
      [`x. The Claude app did not open the session in the right folder, and the server could not start the same brief in the CLI: busy`, "o app não abriu na pasta certa, e a linha de comando recusou a mesma tarefa: busy"],
      [`${own}: the new session shows another folder in its chips (the folder before), not x; nothing was clicked or typed`, "o app abriu a sessão nova na pasta anterior, não na worktree do OMB"],
      [`${own}: the new session's folder chip is cut short to a start that another worktree of the repository shares, not only x`, "o app mostrou um nome de pasta cortado que serve para mais de uma worktree; não dá para saber se é a do OMB"],
      [`${own}: the app asks to trust the workspace x again after the server clicked it once in this create; no second click`, "o app pediu de novo para confiar no workspace depois do clique do servidor"],
      [`${own}: the new session shows a scratch folder of the app's, not only x`, "o app levou a sessão nova para uma pasta de rascunho (scratch) depois do clique em Confiar"],
      [`${own} (the new session shows another folder in its chips), and then New Session failed too: could not open the session after 5 tries`, "o app não abriu a sessão na worktree do OMB, e a sessão nova pelo jeito antigo também falhou"],
      ["o app não abriu …; and New Session, the old way, would land in a wrong folder now — não abri", "o app não abriu a sessão na worktree do OMB, e a sessão nova pelo jeito antigo cairia numa pasta errada"],
      ["New Session did not show a new session's screen (no empty task field and no folder chips; the screen shows a conversation); nothing was typed", "o app não mostrou a tela de sessão nova (apareceu uma conversa)"],
    ];
    for (const [error, said] of cases) expect({ error: error.slice(0, 60), said: sessionErrorPt(error) }).toEqual({ error: error.slice(0, 60), said });
  });
});
