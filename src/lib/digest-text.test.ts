import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { digestTooltip } from "./digest-text";

beforeEach(() => setLocale("pt-br"));
afterEach(() => setLocale("en"));

describe("the digest tooltip", () => {
  it("reads in the person's language, the stored English line aside", () => {
    const text = digestTooltip({
      tools: [{ name: "Bash", count: 3, failed: 1 }, { name: "Read", count: 2 }],
      toolsDropped: 2,
      files: { changed: ["src/a.ts"], added: ["src/b.ts"], deleted: [], truncated: 1 },
      memory: [{ path: "MEMORY.md", kind: "updated" }],
      reply: "Pronto.",
      hookCoverage: "full",
    } as never);
    expect(text).toBe("Ferramentas: Bash ×3 (1 com falha), Read ×2 +2 outras\nArquivos: alterou src/a.ts; criou src/b.ts; +1 outros caminhos\nMemória: MEMORY.md\nResposta: Pronto.");
    expect(digestTooltip({ tools: [], memory: [], reply: "", hookCoverage: "none" } as never)).toBe("Nenhuma atividade de ferramenta observada neste turno");
    expect(text).not.toMatch(/tools:|changed|failed\)/);
  });
});
