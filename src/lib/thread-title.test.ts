import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { displayThreadTitle, shownTaskTitle } from "./thread-title";

afterEach(() => setLocale("en"));

describe("displayThreadTitle", () => {
  it("shows the server's own titles in the person's language and leaves the rest alone", () => {
    setLocale("pt-br");
    expect(displayThreadTitle("New thread")).toBe("Nova conversa");
    expect(displayThreadTitle("Team incidents")).toBe("Incidentes do time");
    expect(displayThreadTitle("#9298 automação · parallel work")).toBe("#9298 automação · trabalho paralelo");
    expect(displayThreadTitle("New thread about X")).toBe("New thread about X");
    setLocale("en");
    expect(displayThreadTitle("Team incidents")).toBe("Team incidents");
  });

  // R11-visual N9: 80+ open conversations began with "@Bot", many as "@Chief of Staff · work"
  it("never opens with a mention nor ends in an English '· work': who asked comes after what", () => {
    setLocale("pt-br");
    expect(displayThreadTitle("@Chief of Staff · work")).toBe("Pedido de Chief of Staff");
    expect(displayThreadTitle("@Chief of Staff · parallel work")).toBe("Trabalho paralelo de Chief of Staff");
    expect(displayThreadTitle("@Chief of Staff · Artigo 2: refazer na segunda")).toBe("Artigo 2: refazer na segunda · de Chief of Staff");
    expect(displayThreadTitle("@Monitor Chat Atendimento · #9298 automação · parallel work")).toBe("#9298 automação · trabalho paralelo · de Monitor Chat Atendimento");
    expect(displayThreadTitle("@Lead PRODEV")).toBe("Pedido de Lead PRODEV");
    expect(displayThreadTitle("@Monitor Chat Atendimento", ["Monitor Chat Atendimento"])).toBe("Pedido de Monitor Chat Atendimento");
    expect(displayThreadTitle("@Chief of Staff conferir o carrier da #9315", ["Chief of Staff"])).toBe("Conferir o carrier da #9315");
    expect(shownTaskTitle({ title: "@Chief of Staff conferir o carrier", openedBy: { name: "Chief of Staff" } })).toBe("Conferir o carrier");
    expect(displayThreadTitle("Sessão da #9058")).toBe("Sessão da #9058");
    setLocale("en");
    expect(displayThreadTitle("@Chief of Staff · work")).toBe("Request from Chief of Staff");
  });
});
