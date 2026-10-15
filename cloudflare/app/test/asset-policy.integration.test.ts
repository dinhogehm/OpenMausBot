import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";

it.each(["GET", "HEAD"])("allows private screenshot blobs in %s assets without opening script or network sources", async (method) => {
  const bindings = {
    ...env,
    ASSETS: { fetch: async () => new Response(method === "HEAD" ? null : "<!doctype html><title>Fixture</title>", { headers: { "content-type": "text/html" } }) },
  } as unknown as AppEnv;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(bindings.APP_ORIGIN, { method }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  const directives = new Map(response.headers.get("content-security-policy")!.split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  }));
  expect(directives.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
  for (const name of ["default-src", "script-src", "style-src", "connect-src", "font-src", "form-action"]) {
    expect(directives.get(name), name).toEqual(["'self'"]);
  }
  for (const name of ["object-src", "frame-ancestors", "base-uri"]) {
    expect(directives.get(name), name).toEqual(["'none'"]);
  }
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
