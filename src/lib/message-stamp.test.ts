import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { fullStamp, messageStamp, needsYouLabel, sharesStamp, sidebarStamp } from "./message-stamp";

const at = (text: string) => new Date(text).getTime();
const now = at("2026-09-30T10:30:00");

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("message stamps", () => {
  it("says today, yesterday, or the date, in pt-BR", () => {
    expect(messageStamp(at("2026-09-30T10:16:00"), now)).toBe("hoje 10:16");
    expect(messageStamp(at("2026-09-29T22:47:00"), now)).toBe("ontem 22:47");
    expect(messageStamp(at("2026-09-28T11:16:00"), now)).toBe("28/09 11:16");
    expect(messageStamp(at("2025-12-31T09:05:00"), now)).toBe("31/12/2025 09:05");
  });

  it("keeps the sidebar short: time today, yesterday with time, then only the date", () => {
    expect(sidebarStamp(at("2026-09-30T10:16:00"), now)).toBe("10:16");
    expect(sidebarStamp(at("2026-09-29T11:16:00"), now)).toBe("ontem 11:16");
    expect(sidebarStamp(at("2026-09-29T11:16:00") - 86_400_000, now)).toBe("28/09");
  });

  it("gives the tooltip the full date and time to the second", () => {
    expect(fullStamp(at("2026-09-30T10:16:42"))).toMatch(/30 de setembro de 2026.*10:16:42/);
  });

  it("shares one stamp across one author's messages in the same minute", () => {
    const a = { role: "bot", at: at("2026-09-30T10:16:05") };
    expect(sharesStamp(a, { role: "bot", at: at("2026-09-30T10:16:50") })).toBe(true);
    expect(sharesStamp(a, { role: "bot", at: at("2026-09-30T10:17:01") })).toBe(false);
    expect(sharesStamp(a, { role: "user", at: at("2026-09-30T10:16:50") })).toBe(false);
    expect(sharesStamp(undefined, a)).toBe(false);
  });
});

describe("needs-you label", () => {
  it("shows its age once the ask is not fresh", () => {
    expect(needsYouLabel(now - 5 * 60_000, now)).toBe("Precisa de você");
    expect(needsYouLabel(at("2026-09-29T22:18:00"), now)).toBe("Precisa de você · desde ontem 22:18");
    expect(needsYouLabel(undefined, now)).toBe("Precisa de você");
  });
});
