import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { displayThreadTitle } from "./thread-title";

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
});
