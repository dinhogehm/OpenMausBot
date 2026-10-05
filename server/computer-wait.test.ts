import { describe, expect, it } from "vitest";

import {
  computerFreeAfterText,
  computerStillBusyText,
  computerStoppedWaitingText,
  computerWaitDuration,
  computerWaitingText,
} from "./computer-wait.ts";

describe("computer wait wording", () => {
  it("reads as a queue position behind a named turn, never as an error", () => {
    expect(computerWaitingText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, "en")).toBe(
      "Waiting for its turn on this computer — TCPR operator is running TCPR 3 hour capacity refill. Starts automatically when that finishes.",
    );
    // a holder with no thread title (a room, or a bot's untitled turn)
    expect(computerWaitingText({ name: "Engineering Room" }, "en")).toBe(
      "Waiting for its turn on this computer — Engineering Room is using it. Starts automatically when that finishes.",
    );
    expect(computerWaitingText(undefined, "en")).toBe("Waiting for its turn on this computer. Starts automatically when it is free.");
    for (const text of [computerWaitingText({ name: "Ada", task: "Refill" }, "en"), computerWaitingText(null, "en")]) {
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

  it("names the holder and a way out when the wait gives up", () => {
    expect(computerStillBusyText({ name: "TCPR operator", task: "TCPR 3 hour capacity refill" }, 30 * 60_000, "en")).toBe(
      "Computer is still busy after 30 minutes — TCPR operator is still running TCPR 3 hour capacity refill. Stop that turn, or run this on another computer.",
    );
    expect(computerStillBusyText({ name: "Ada" }, 30 * 60_000, "en")).toBe(
      "Computer is still busy after 30 minutes — Ada is still using it. Stop that turn, or run this on another computer.",
    );
    expect(computerStillBusyText(undefined, 45_000, "en")).toBe("Computer is still busy after 45 seconds. Stop that turn, or run this on another computer.");
  });

  // R11/R12-followup #4: on 04/10 20:24:33 the owner read, in the o14 conversation,
  // "Waiting for its turn on this computer — Monitor … is running … Starts automatically when that finishes."
  it("speaks the owner's language by default: pt-BR, the same words on every chip", () => {
    const monitor = { name: "Monitor Chat Atendimento", task: "Vigias do atendimento" };
    expect(computerWaitingText(monitor)).toBe(
      "Aguardando a vez neste computador — Monitor Chat Atendimento está rodando «Vigias do atendimento». Começa sozinho quando isso terminar.",
    );
    expect(computerWaitingText({ name: "Sala de Engenharia" }, "pt-br")).toBe(
      "Aguardando a vez neste computador — Sala de Engenharia está usando o computador. Começa sozinho quando isso terminar.",
    );
    expect(computerWaitingText(null)).toBe("Aguardando a vez neste computador. Começa sozinho quando ele ficar livre.");
    expect(computerFreeAfterText(monitor, 65_000)).toBe("Computador livre — seguindo depois de esperar 1 minuto (estava com Monitor Chat Atendimento · Vigias do atendimento)");
    expect(computerFreeAfterText(undefined, 800)).toBe("Computador livre — seguindo depois de esperar menos de um segundo");
    expect(computerStoppedWaitingText({ name: "Ada", task: "Refill" }, 2_500)).toBe("Parou de esperar pelo computador depois de 3 segundos — Ada está rodando «Refill».");
    expect(computerStillBusyText(monitor, 30 * 60_000)).toBe(
      "O computador continua ocupado depois de 30 minutos — Monitor Chat Atendimento ainda está rodando «Vigias do atendimento». Pare aquele turno ou rode este em outro computador.",
    );
    expect(computerStillBusyText({ name: "Ada" }, 45_000, "pt")).toBe(
      "O computador continua ocupado depois de 45 segundos — Ada ainda está usando o computador. Pare aquele turno ou rode este em outro computador.",
    );
    // another language picked in the app keeps the English chips
    expect(computerWaitingText(monitor, "de")).toMatch(/^Waiting for its turn on this computer/);
  });
});
