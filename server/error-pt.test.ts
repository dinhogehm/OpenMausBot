import { describe, expect, it } from "vitest";
import { computerErrorPt, isInfraFailure } from "./error-pt.ts";

describe("computer errors in pt-BR", () => {
  it("reads the known ones in Portuguese and leaves the rest", () => {
    expect(computerErrorPt("This desktop image cannot safely resume; recreate the Local VM")).toBe("a VM local não pode ser retomada com segurança; recrie a VM local");
    expect(computerErrorPt("Start docker first")).toBe("o docker não está rodando; inicie-o primeiro");
    expect(computerErrorPt("something else")).toBe("something else");
  });

  it("tells a computer or engine being away from a failure of the work itself", () => {
    expect(isInfraFailure("Start docker first")).toBe(true);
    expect(isInfraFailure("This desktop image cannot safely resume; recreate the Local VM")).toBe(true);
    expect(isInfraFailure("provider settings are being updated — try again shortly")).toBe(true);
    expect(isInfraFailure("no such bot")).toBe(false);
    expect(isInfraFailure("Result withheld: team or peer access changed")).toBe(false);
  });
});
