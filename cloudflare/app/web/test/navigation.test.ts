import assert from "node:assert/strict";
import { test } from "node:test";
import { readRoute, routeHash, resolveOrganization, sectionPaths } from "../src/navigation.ts";

test("each section restores the selected company from a shareable route", () => {
  for (const section of Object.keys(sectionPaths) as Array<keyof typeof sectionPaths>) {
    assert.deepEqual(readRoute(routeHash(section, "company/a?b & café")), { section, organizationId: "company/a?b & café" });
  }
});
test("the GitHub return preserves its company and repository destination", () => {
  assert.deepEqual(readRoute("#/relatorios?empresa=old", "?github=installed&organization=returned"), { section: "repositories", organizationId: "returned" });
});
test("unknown or malformed routes fall back without using an arbitrary section", () => {
  for (const hash of ["", "#javascript:alert(1)", "#/unknown?empresa=outside", "#/%E0%A4%A"]) {
    assert.deepEqual(readRoute(hash), { section: "coding", organizationId: "" });
  }
});
test("an address never selects a company outside the authenticated memberships", () => {
  const memberships = [{ id: "one" }, { id: "two" }];
  assert.equal(resolveOrganization("two", memberships), "two");
  assert.equal(resolveOrganization("forbidden", memberships), "one");
  assert.equal(resolveOrganization("one", []), "");
});
