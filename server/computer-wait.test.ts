import { describe, expect, it } from "vitest";

import {
  computerFreeAfterText,
  computerParkedText,
  computerStoppedWaitingText,
  computerWaitDuration,
  computerWaitingText,
} from "./computer-wait.ts";

describe("computer wait wording", () => {
  it("reads as a queue position behind a named turn, never as an error", () => {
    expect(computerWaitingText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, undefined, "en")).toBe(
      "Waiting for its turn on this computer — TCPR operator is running TCPR 3 hour capacity refill. Starts automatically when that finishes.",
    );
    // a holder with no thread title (a room, or a bot's untitled turn)
    expect(computerWaitingText({ name: "Engineering Room" }, undefined, "en")).toBe(
      "Waiting for its turn on this computer — Engineering Room is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText(undefined, undefined, "en")).toBe("Waiting for its turn on this computer. Starts automatically when it is free.");
    for (const text of [computerWaitingText({ name: "Ada", task: "Refill" }, undefined, "en"), computerWaitingText(null, undefined, "en")]) {
      expect(text).not.toMatch(/error|failed|blocked/i);
    }
  });

  it("resolves with a history line beside the untouched waiting chip", () => {
    expect(computerFreeAfterText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 65_000, "en")).toBe(
      "Computer free — continuing after waiting 1 minute (TCPR operator · TCPR 3 hour capacity refill held it)",
    );
    expect(computerFreeAfterText({ name: "Engineering Room" }, 90_000, "en")).toBe(
      "Computer free — continuing after waiting 2 minutes (Engineering Room held it)",
    );
    expect(computerFreeAfterText(undefined, 4_000, "en")).toBe("Computer free — continuing after waiting 4 seconds");
    expect(computerStoppedWaitingText({ name: "Ada", task: "Refill" }, 2_500, "en")).toBe(
      "Stopped waiting for the computer after 3 seconds — Ada is running Refill.",
    );
    expect(computerStoppedWaitingText(null, 800, "en")).toBe("Stopped waiting for the computer after under a second.");
  });

  it("says the queue position, and an estimate only once history exists", () => {
    expect(computerWaitingText({ name: "Ada", task: "Refill" }, { position: 1 }, "en")).toBe(
      "Waiting for its turn on this computer — 1st in queue — Ada is running Refill. Starts automatically when that finishes.",
    );
    expect(computerWaitingText({ name: "Engineering Room" }, { position: 3 }, "en")).toBe(
      "Waiting for its turn on this computer — 3rd in queue — Engineering Room is using it. Starts automatically when the turns ahead finish.",
    );
    expect(computerWaitingText(null, { position: 2, estimateMs: 90_000 }, "en")).toBe(
      "Waiting for its turn on this computer — 2nd in queue. Starts automatically when the turns ahead finish; recent waits here have taken 2 minutes.",
    );
    expect(computerWaitingText({ name: "Ada" }, { position: 4, estimateMs: 500 }, "en")).toBe(
      "Waiting for its turn on this computer — 4th in queue — Ada is using it. Starts automatically when the turns ahead finish; recent waits here have taken under a second.",
    );
    // No queue fact (older callers) and no history yet: today's exact text.
    expect(computerWaitingText({ name: "Ada" }, undefined, "en")).toBe(
      "Waiting for its turn on this computer — Ada is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText({ name: "Ada", task: "Refill" }, {}, "en")).toBe(
      "Waiting for its turn on this computer — Ada is running Refill. Starts automatically when that finishes.",
    );
    for (const position of [11, 12, 13, 21, 22, 23]) {
      const suffix = position === 11 || position === 12 || position === 13 ? "th"
        : position % 10 === 1 ? "st" : position % 10 === 2 ? "nd" : "rd";
      expect(computerWaitingText(undefined, { position }, "en")).toContain(position + suffix + " in queue");
    }
  });

  it("phrases a wait duration honestly at every scale", () => {
    expect(computerWaitDuration(0)).toBe("under a second");
    expect(computerWaitDuration(999)).toBe("under a second");
    expect(computerWaitDuration(1_000)).toBe("1 second");
    expect(computerWaitDuration(59_499)).toBe("59 seconds");
    expect(computerWaitDuration(90_000)).toBe("2 minutes");
    expect(computerWaitDuration(500, "pt-br")).toBe("menos de um segundo");
    expect(computerWaitDuration(1_000, "pt-br")).toBe("1 segundo");
    expect(computerWaitDuration(90_000, "pt-br")).toBe("2 minutos");
  });

  it("names the holder and says the work continues when the wait parks", () => {
    expect(computerParkedText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 30 * 60_000, "en")).toBe(
      "Computer still busy after 30 minutes — TCPR operator is still running TCPR 3 hour capacity refill. Parked — it continues automatically when the computer is free.",
    );
    expect(computerParkedText({ name: "Ada" }, 30 * 60_000, "en")).toBe(
      "Computer still busy after 30 minutes — Ada is still using it. Parked — it continues automatically when the computer is free.",
    );
    expect(computerParkedText(undefined, 45_000, "en")).toBe(
      "Computer still busy after 45 seconds. Parked — it continues automatically when the computer is free.",
    );
  });

  // R11/R12-followup #4: on 04/10 20:24:33 the owner read, in the o14 conversation,
  // "Waiting for its turn on this computer — Monitor … is running … Starts automatically when that finishes."
  it("speaks the owner's language by default: pt-BR, the same words on every chip", () => {
    const monitor = { name: "Monitor Chat Atendimento", task: "Vigias do atendimento" };
    expect(computerWaitingText(monitor)).toBe(
      "Aguardando a vez neste computador — Monitor Chat Atendimento está rodando «Vigias do atendimento». Começa sozinho quando isso terminar.",
    );
    expect(computerWaitingText({ name: "Sala de Engenharia" }, undefined, "pt-br")).toBe(
      "Aguardando a vez neste computador — Sala de Engenharia está usando o computador. Começa sozinho quando isso terminar.",
    );
    expect(computerWaitingText(null)).toBe("Aguardando a vez neste computador. Começa sozinho quando ele ficar livre.");
    // the queue position and the estimate (#1652) in the same words
    expect(computerWaitingText(monitor, { position: 1 })).toBe(
      "Aguardando a vez neste computador — 1º na fila — Monitor Chat Atendimento está rodando «Vigias do atendimento». Começa sozinho quando isso terminar.",
    );
    expect(computerWaitingText(null, { position: 2, estimateMs: 90_000 })).toBe(
      "Aguardando a vez neste computador — 2º na fila. Começa sozinho quando os turnos à frente terminarem; as esperas recentes aqui levaram 2 minutos.",
    );
    expect(computerFreeAfterText(monitor, 65_000)).toBe("Computador livre — seguindo depois de esperar 1 minuto (estava com Monitor Chat Atendimento · Vigias do atendimento)");
    expect(computerFreeAfterText(undefined, 800)).toBe("Computador livre — seguindo depois de esperar menos de um segundo");
    expect(computerStoppedWaitingText({ name: "Ada", task: "Refill" }, 2_500)).toBe("Parou de esperar pelo computador depois de 3 segundos — Ada está rodando «Refill».");
    expect(computerParkedText(monitor, 30 * 60_000)).toBe(
      "O computador continua ocupado depois de 30 minutos — Monitor Chat Atendimento ainda está rodando «Vigias do atendimento». Em espera — continua sozinho quando o computador ficar livre.",
    );
    expect(computerParkedText({ name: "Ada" }, 45_000, "pt")).toBe(
      "O computador continua ocupado depois de 45 segundos — Ada ainda está usando o computador. Em espera — continua sozinho quando o computador ficar livre.",
    );
    // another language picked in the app keeps the English chips
    expect(computerWaitingText(monitor, undefined, "de")).toMatch(/^Waiting for its turn on this computer/);
  });
});
