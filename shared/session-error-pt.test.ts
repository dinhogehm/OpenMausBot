import { describe, expect, it } from "vitest";
import { sessionErrorPt } from "./session-error-pt.ts";

describe("a session's error in pt-BR", () => {
  it("reads the known ones in Portuguese and leaves the rest", () => {
    expect(sessionErrorPt("could not send the message after 5 tries with the screen unlocked")).toBe("não foi possível enviar a mensagem depois de 5 tentativas");
    expect(sessionErrorPt("the turn ran past 90 minutes and was stopped")).toBe("o turno passou de 90 minutos e foi parado");
    expect(sessionErrorPt("could not archive the session in the Claude app: busy")).toBe("não foi possível arquivar a sessão no app Claude");
    expect(sessionErrorPt("something new")).toBe("something new");
  });
});
