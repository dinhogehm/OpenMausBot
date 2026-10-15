import puppeteer, { type Browser, type Page, type HTTPRequest } from "@cloudflare/puppeteer";
import { BROWSER_LIMITS, type BrowserAction, type BrowserObservation } from "./browser-types";
import { browserUrl } from "./browser-state";
import { proxyBrowserRequest, type BrowserNetworkBudget } from "./browser-network";

export interface BrowserBinding {
  fetch: typeof fetch;
  acquire(options?: BrowserRunAcquireOptions): Promise<BrowserRunAcquireResult>;
  getSession(sessionId: string): Promise<BrowserRunSession | null>;
  closeSession(sessionId: string): Promise<BrowserRunCloseSessionResult>;
}
export async function closeBrowserSession(binding: BrowserBinding, sessionId: string): Promise<boolean> {
  try {
    const result = await binding.closeSession(sessionId);
    if (result.status === "closed") return true;
    const session = await binding.getSession(sessionId); return !session || !!session.endTime;
  } catch (error) {
    // Verified native binding response differs from the documented null result.
    // A generic 404 or a transport error never establishes session closure.
    if (error instanceof Error && error.message === "Session not found (status=404)") return true;
    throw error;
  }
}

/** Every native web request is denied. CDP interception can only fulfill
 * responses obtained by the bounded, strictly-public Worker proxy. */
export class CloudBrowserRuntime {
  private browser?: Browser;
  private page?: Page;
  private pending = new Set<Promise<void>>();
  private requestsBlocked = 0;
  private constructor(private binding: BrowserBinding, readonly sessionId: string, private hosts: string[],
    private budget: BrowserNetworkBudget, private signal: AbortSignal, private requestFetch: typeof fetch) {}

  static async acquire(binding: BrowserBinding, hosts: string[], budget: BrowserNetworkBudget, signal: AbortSignal,
    acquired: (sessionId: string) => Promise<void>, requestFetch: typeof fetch = fetch): Promise<CloudBrowserRuntime> {
    await budget.assertActive();
    const session = await binding.acquire({ keepAlive: 60000, recording: false, guardrails: { allowedDomains: [] } });
    const runtime = new CloudBrowserRuntime(binding, session.sessionId, hosts, budget, signal, requestFetch);
    try { await acquired(session.sessionId); await runtime.connect(); await budget.assertActive(); if (signal.aborted) throw new Error("browser_canceled"); return runtime; }
    catch (error) { await runtime.close().catch(() => false); throw error; }
  }
  static async resume(binding: BrowserBinding, sessionId: string, hosts: string[], budget: BrowserNetworkBudget, signal: AbortSignal,
    requestFetch: typeof fetch = fetch): Promise<CloudBrowserRuntime> {
    const runtime = new CloudBrowserRuntime(binding, sessionId, hosts, budget, signal, requestFetch);
    try { await runtime.connect(); await budget.assertActive(); if (signal.aborted) throw new Error("browser_canceled"); return runtime; }
    catch (error) { await runtime.close().catch(() => false); throw error; }
  }
  private async connect() {
    await this.budget.assertActive();
    this.browser = await puppeteer.connect(this.binding, this.sessionId);
    const pages = await this.browser.pages();
    this.page = pages[0] ?? await this.browser.newPage();
    for (const page of pages.slice(1)) await page.close();
    const page = this.page;
    await page.setViewport({ width: BROWSER_LIMITS.width, height: BROWSER_LIMITS.height, deviceScaleFactor: 1 });
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
    await page.setCacheEnabled(false); await page.setBypassServiceWorker(true);
    const client = await page.createCDPSession();
    await client.send("Browser.setDownloadBehavior", { behavior: "deny" }); await client.detach();
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    this.browser.on("targetcreated", (target) => { void target.page().then((opened) => { if (opened && opened !== page) return opened.close(); }).catch(() => {}); });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const operation = this.intercept(request); this.pending.add(operation);
      void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    });
  }
  private async intercept(request: HTTPRequest): Promise<void> {
    try {
      if (this.signal.aborted) throw new Error("browser_canceled");
      const response = await proxyBrowserRequest({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() },
        this.hosts, this.budget, this.signal, this.requestFetch);
      if (!request.isInterceptResolutionHandled()) await request.respond(response);
    } catch {
      this.requestsBlocked++;
      if (!request.isInterceptResolutionHandled()) await request.abort("blockedbyclient").catch(() => {});
    }
  }
  async navigate(url: string): Promise<void> {
    await this.budget.assertActive(); if (this.signal.aborted || !this.page) throw new Error("browser_canceled");
    const response = await this.page.goto(browserUrl(url, this.hosts), { waitUntil: "domcontentloaded", timeout: 15000 });
    await this.budget.assertActive();
    if (!response || response.status() >= 400) throw new Error("browser_navigation_failed");
  }
  async observe(): Promise<BrowserObservation> {
    await this.budget.assertActive(); if (this.signal.aborted || !this.page) throw new Error("browser_canceled");
    const value = await this.page.evaluate("JSON.stringify({url:location.href,title:document.title.slice(0,500),text:(document.body?.innerText??'').slice(0,12000)})") as string;
    const data = JSON.parse(value) as { url: string; title: string; text: string };
    browserUrl(data.url, this.hosts);
    const jpeg = new Uint8Array(await this.page.screenshot({ type: "jpeg", quality: 50, fullPage: false, captureBeyondViewport: false }));
    await this.budget.assertActive();
    if (!jpeg.length || jpeg.length > BROWSER_LIMITS.screenshotBytes) throw new Error("browser_screenshot_limit");
    return { ...data, text: `${data.text}\n[Blocked browser requests: ${this.requestsBlocked}]`, jpeg };
  }
  async act(action: BrowserAction): Promise<void> {
    await this.budget.assertActive(); if (this.signal.aborted || !this.page) throw new Error("browser_canceled");
    if (action.kind === "navigate") await this.navigate(action.url);
    else if (action.kind === "click") await this.page.mouse.click(action.x, action.y);
    else if (action.kind === "type") await this.page.keyboard.type(action.text);
    else if (action.kind === "press") await this.page.keyboard.press(action.key);
    else if (action.kind === "scroll") await this.page.mouse.wheel({ deltaY: action.direction === "down" ? action.amount : -action.amount });
    // This is a fixed wait for the page to react, not a model-controlled sleep.
    if (action.kind !== "finish") await new Promise((resolve) => setTimeout(resolve, 250));
    await this.budget.assertActive();
  }
  async close(): Promise<boolean> {
    this.browser?.disconnect(); this.browser = undefined; this.page = undefined;
    return closeBrowserSession(this.binding, this.sessionId);
  }
}
