import puppeteer, { type Browser, type HTTPRequest } from "@cloudflare/puppeteer";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrowserRuntime, closeBrowserSession, type BrowserBinding } from "../src/browser-runtime";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  let handler: (request: HTTPRequest) => void;
  const page = {
    setViewport: vi.fn(async () => {}), setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
    setCacheEnabled: vi.fn(async () => {}), setBypassServiceWorker: vi.fn(async () => {}),
    createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => {}), detach: vi.fn(async () => {}) })),
    setRequestInterception: vi.fn(async () => {}), on: vi.fn((event, callback) => { if (event === "request") handler = callback; }),
    evaluate: vi.fn(async () => JSON.stringify({ url: "https://example.com/", title: "Synthetic page", text: "Synthetic content" })),
    screenshot: vi.fn(async () => new Uint8Array([255, 216, 255, 217])),
    mouse: { click: vi.fn(async () => {}), wheel: vi.fn(async () => {}) }, keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    goto: vi.fn(async (_url: string) => ({ status: () => 200 })),
  };
  const browser = { pages: vi.fn(async () => [page]), disconnect: vi.fn(), on: vi.fn() };
  vi.spyOn(puppeteer, "connect").mockResolvedValue(browser as unknown as Browser);
  const binding = { fetch: vi.fn(), acquire: vi.fn(async () => ({ sessionId: "synthetic-session" })), getSession: vi.fn(async () => null), closeSession: vi.fn(async () => ({ status: "closed" })) };
  const budget = { assertActive: vi.fn(async () => {}), reserve: vi.fn(async (_bytes: number) => {}), refund: vi.fn(async (_bytes: number) => {}) };
  const fetcher = vi.fn<typeof fetch>(async (url) => new URL(String(url)).hostname === "cloudflare-dns.com" ? Response.json({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1" }] }) : new Response("Synthetic response"));
  return { page, browser, binding, budget, fetcher, request: (request: HTTPRequest) => handler(request) };
}

it("keeps native egress deny-all and only fulfills responses fetched through the public proxy", async () => {
  const f = fixture(); const acquired = vi.fn(async (_id: string) => {});
  const runtime = await CloudBrowserRuntime.acquire(f.binding as unknown as BrowserBinding, ["example.com"], f.budget, new AbortController().signal, acquired, f.fetcher);
  expect(f.binding.acquire).toHaveBeenCalledWith({ keepAlive: 60000, recording: false, guardrails: { allowedDomains: [] } });
  expect(acquired).toHaveBeenCalledWith("synthetic-session");
  expect(f.page.setBypassServiceWorker).toHaveBeenCalledWith(true); expect(f.page.setCacheEnabled).toHaveBeenCalledWith(false);
  const respond = vi.fn(async () => {}), abort = vi.fn(async () => {});
  const request = { url: () => "https://example.com/", method: () => "GET", headers: () => ({}), postData: () => undefined, isInterceptResolutionHandled: () => false, respond, abort };
  f.request(request as unknown as HTTPRequest); await expect.poll(() => respond.mock.calls.length).toBe(1);
  expect(abort).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(3);
  await runtime.navigate("https://example.com/"); expect((await runtime.observe()).text).toContain("Synthetic content");
  await runtime.act({ kind: "click", x: 3, y: 4 }); expect(f.page.mouse.click).toHaveBeenCalledWith(3, 4);
  expect(await runtime.close()).toBe(true); expect(f.browser.disconnect).toHaveBeenCalled();
});

it("blocks a foreign request without calling fetch and closes a resumed session whose setup fails", async () => {
  const f = fixture(); const runtime = await CloudBrowserRuntime.acquire(f.binding as unknown as BrowserBinding, ["example.com"], f.budget, new AbortController().signal, async () => {}, f.fetcher);
  const abort = vi.fn(async () => {});
  f.request({ url: () => "https://attacker.com/", method: () => "GET", headers: () => ({}), postData: () => undefined, isInterceptResolutionHandled: () => false, respond: vi.fn(), abort } as unknown as HTTPRequest);
  await expect.poll(() => abort.mock.calls.length).toBe(1); expect(f.fetcher).not.toHaveBeenCalled(); await runtime.close();
  f.page.setViewport.mockRejectedValueOnce(new Error("setup failed"));
  await expect(CloudBrowserRuntime.resume(f.binding as unknown as BrowserBinding, "synthetic-session", ["example.com"], f.budget, new AbortController().signal, f.fetcher)).rejects.toThrow("setup failed");
  expect(f.browser.disconnect).toHaveBeenCalledTimes(2); expect(f.binding.closeSession).toHaveBeenCalledTimes(2);
});

it("rejects and closes an acquisition if cancellation arrives during client connection", async () => {
  const f = fixture(); const controller = new AbortController();
  f.page.setViewport.mockImplementationOnce(async () => { controller.abort(); });
  await expect(CloudBrowserRuntime.acquire(f.binding as unknown as BrowserBinding, ["example.com"], f.budget, controller.signal, async () => {}, f.fetcher)).rejects.toThrow("browser_canceled");
  expect(f.browser.disconnect).toHaveBeenCalled(); expect(f.binding.closeSession).toHaveBeenCalled(); expect(f.page.goto).not.toHaveBeenCalled();
});

it("accepts the verified native missing-session response but never a generic transport 404", async () => {
  const f = fixture(); f.binding.closeSession.mockRejectedValueOnce(new Error("Session not found (status=404)"));
  expect(await closeBrowserSession(f.binding as unknown as BrowserBinding, "synthetic-session")).toBe(true);
  f.binding.closeSession.mockRejectedValueOnce(new Error("Upstream proxy failed: 404"));
  await expect(closeBrowserSession(f.binding as unknown as BrowserBinding, "synthetic-session")).rejects.toThrow("Upstream proxy failed");
});
