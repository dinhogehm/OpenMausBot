import { describe, expect, it } from "vitest";
import { computerErrorPt } from "./error-pt.ts";

describe("computer errors in pt-BR", () => {
  it("reads the known ones in Portuguese and leaves the rest", () => {
    expect(computerErrorPt("This desktop image cannot safely resume; recreate the Local VM")).toBe("a VM local não pode ser retomada com segurança; recrie a VM local");
    expect(computerErrorPt("Start docker first")).toBe("o docker não está rodando; inicie-o primeiro");
    expect(computerErrorPt("something else")).toBe("something else");
  });
});
