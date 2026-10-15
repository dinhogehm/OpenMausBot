// Operator-only disposable proof. No app database, credentials or AI models.
import { CloudBrowserRuntime, type BrowserBinding } from "../../src/browser-runtime";
import { proxyBrowserRequest } from "../../src/browser-network";
interface Env { BROWSER: BrowserBinding; FIXTURE_TOKEN_HASH: string; FIXTURE_EXPIRES_AT: string }
const site = `<!doctype html><html><head><title>Veltram browser proof</title><style>
body{font:20px sans-serif;padding:24px}input{position:absolute;left:40px;top:100px;width:300px;height:40px}button{position:absolute;left:40px;top:160px;width:300px;height:44px}#result{position:absolute;top:230px}</style></head>
<body><h1>Isolated Cloudflare browser</h1><input aria-label="Synthetic value"><button>Confirm synthetic value</button><p id="result">Waiting</p><p id="network">WebSocket pending</p>
<img src="https://example.com/veltram-blocked-fixture.png" alt="blocked fixture">
<script>document.querySelector('button').onclick=()=>document.querySelector('#result').textContent='Confirmed: '+document.querySelector('input').value;
const socket=new WebSocket('wss://'+location.host+'/socket');socket.onmessage=()=>document.querySelector('#network').textContent='UNEXPECTED WEBSOCKET ACCESS';socket.onerror=()=>document.querySelector('#network').textContent='WebSocket blocked';</script></body></html>`;
export default {
  async fetch(request: Request, env: Env) {
    if (Date.now() >= Number(env.FIXTURE_EXPIRES_AT)) return new Response("Expired", { status: 410 });
    const url = new URL(request.url);
    if (url.pathname === "/site") return new Response(site, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/socket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const [client, server] = Object.values(new WebSocketPair()); server.accept(); server.send("unexpected"); server.close(1000);
      return new Response(null, { status: 101, webSocket: client });
    }
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const hash = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    if (!token || hash !== env.FIXTURE_TOKEN_HASH) return new Response(null, { status: 403 });
    if (request.method !== "POST" || url.pathname !== "/prove") return new Response(null, { status: 404 });
    let runtime: CloudBrowserRuntime | undefined; let sessionId: string | undefined;
    const controller = new AbortController(); const deadline = Date.now() + 75000;
    let requests = 0; let bytes = 0; const checks: Record<string, unknown> = { bindingMethods: { acquire: typeof env.BROWSER.acquire, getSession: typeof env.BROWSER.getSession, closeSession: typeof env.BROWSER.closeSession } };
    let failure: string | undefined;
    try {
      const probe = await proxyBrowserRequest({ url: url.origin + "/site", method: "GET", headers: {} }, [url.hostname], {
        async assertActive() {}, async reserve() {}, async refund() {},
      }, controller.signal);
      checks.proxyProbe = { status: probe.status, bytes: probe.body.length };
      runtime = await CloudBrowserRuntime.acquire(env.BROWSER, [url.hostname], {
        async assertActive() { if (controller.signal.aborted || Date.now() >= deadline) throw new Error("fixture_deadline"); },
        async reserve(amount) { requests++; bytes += amount; if (requests > 20 || bytes > 16777216) throw new Error("fixture_network_limit"); },
        async refund(amount) { bytes -= amount; },
      }, controller.signal, async id => { sessionId = id; });
      await runtime.navigate(url.origin + "/site");
      const initial = await runtime.observe(); checks.initialTitle = initial.title; checks.initialUrl = initial.url;
      if (initial.title !== "Veltram browser proof") throw new Error("fixture_title_mismatch");
      await runtime.act({ kind: "click", x: 100, y: 120 });
      await runtime.act({ kind: "type", text: "cloud-isolated-proof" });
      await runtime.act({ kind: "click", x: 100, y: 180 });
      let final = await runtime.observe();
      for (let i = 0; i < 10 && final.text.includes("WebSocket pending"); i++) {
        await new Promise(resolve => setTimeout(resolve, 200)); final = await runtime.observe();
      }
      checks.finalText = final.text;
      checks.inputAndClick = final.text.includes("Confirmed: cloud-isolated-proof");
      checks.nativeWebSocketDenied = final.text.includes("WebSocket blocked") && !final.text.includes("UNEXPECTED");
      checks.interceptionDeniedOutsideHost = /Blocked browser requests: [1-9]/.test(final.text);
      checks.screenshotBytes = final.jpeg.length;
      try { await runtime.navigate("https://example.com/veltram-forbidden"); checks.navigationDenied = false; }
      catch { checks.navigationDenied = true; }
      checks.requests = requests; checks.networkBytes = bytes;
      if (!checks.inputAndClick || !checks.nativeWebSocketDenied || !checks.interceptionDeniedOutsideHost || !checks.navigationDenied || !final.jpeg.length) throw new Error("fixture_assertion_failed");
    } catch (error) { failure = error instanceof Error ? error.message : "proof_failed"; }
    finally {
      controller.abort();
      checks.sessionId = sessionId ?? null;
      try {
        checks.sessionClosed = runtime ? await runtime.close() : sessionId ? (await env.BROWSER.closeSession(sessionId)).status === "closed" : true;
        if (sessionId) {
          try { const session = await env.BROWSER.getSession(sessionId); checks.sessionConfirmedEnded = !session || !!session.endTime; }
          catch (error) {
            checks.sessionConfirmedEnded = error instanceof Error && error.message === "Session not found (status=404)";
            if (!checks.sessionConfirmedEnded) checks.cleanupError = error instanceof Error ? error.message : "cleanup_failed";
          }
        }
      } catch (error) { checks.cleanupError = error instanceof Error ? error.message : "cleanup_failed"; }
    }
    return Response.json({ checks, failure: failure ?? null }, { status: failure || !checks.sessionClosed || !checks.sessionConfirmedEnded ? 500 : 200 });
  },
};
