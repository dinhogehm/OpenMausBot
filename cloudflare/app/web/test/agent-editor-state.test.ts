import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptProfileChanges, getProfileDraft, updateProfileDraft } from "../src/agent-editor-state.ts";

const profile = (sourceId: string) => ({ sourceId, name: sourceId, title: "", description: "", instructions: "Original", section: "Equipe", sourceEngine: "Veltram", sourceModel: "", sourceEffort: "" });

test("editing and saving a second agent preserves the first agent's unsaved instructions", () => {
  const first = profile("first"), second = profile("second");
  let drafts = updateProfileDraft({}, first, { ...first, instructions: "Alteração não salva" });
  drafts = updateProfileDraft(drafts, second, { ...second, name: "Segundo editado" });
  const accepted = acceptProfileChanges(drafts, [drafts.second]);
  assert.equal(accepted.first.instructions, "Alteração não salva");
  assert.equal(accepted.second, undefined);
  assert.equal(drafts.second.name, "Segundo editado");
});

test("restoring a field to its saved value clears only that profile's dirty state", () => {
  const first = profile("first"), second = profile("second");
  const drafts = { first: { ...first, name: "Rascunho" }, second: { ...second, name: "Outro rascunho" } };
  assert.deepEqual(updateProfileDraft(drafts, first, first), { second: drafts.second });
});

test("accepting an older saved value does not remove a newer draft", () => {
  const first = profile("first");
  const drafts = { first: { ...first, instructions: "Mais recente" } };
  assert.deepEqual(acceptProfileChanges(drafts, [{ ...first, instructions: "Pedido anterior" }]), drafts);
});


test("imported source identities cannot collide with object prototype names", () => {
  assert.equal(getProfileDraft({}, "constructor"), undefined);
  assert.equal(getProfileDraft({}, "__proto__"), undefined);
  const original = profile("__proto__");
  const edited = { ...original, name: "Perfil importado" };
  const drafts = updateProfileDraft({}, original, edited);
  assert.equal(Object.getPrototypeOf(drafts), Object.prototype);
  assert.equal(getProfileDraft(drafts, "__proto__")?.name, "Perfil importado");
  assert.deepEqual(acceptProfileChanges(drafts, [edited]), {});
});
