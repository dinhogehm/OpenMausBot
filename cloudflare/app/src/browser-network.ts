import { isIP } from "node:net";
import { browserHost, browserUrl } from "./browser-state";

export const BROWSER_NETWORK_LIMITS = { requests: 500, bytes: 134217728, responseBytes: 2097152, requestBytes: 65536 } as const;
export interface BrowserNetworkBudget { reserve(bytes: number): Promise<void>; refund(bytes: number): Promise<void>; assertActive(): Promise<void> }
export interface BrowserProxyRequest { url: string; method: string; headers: Record<string, string>; body?: string }
export interface BrowserProxyResponse { status: number; headers: Record<string, string | string[]>; body: Uint8Array }
const encoder = new TextEncoder();

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168))
      && !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0);
  }
  // Only globally routable unicast IPv6 (2000::/3), excluding documentation.
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  return /^[23][0-9a-f]{3}:/i.test(canonical) && !/^2002:|^3fff:|^2001:(?:db8:|:|2:|10:|20:)/i.test(canonical);
}
async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) throw new Error("browser_network_limit"); chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function assertPublicHost(host: string, requestFetch: typeof fetch = fetch): Promise<void> {
  browserHost(host); let addresses = 0;
  for (const type of ["A", "AAAA"]) {
    const url = new URL("https://cloudflare-dns.com/dns-query"); url.searchParams.set("name", host); url.searchParams.set("type", type);
    const response = await requestFetch(url, { headers: { accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(3000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("browser_dns_unavailable"); }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, 16384))) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
    if (data.Status !== 0 || (data.Answer !== undefined && !Array.isArray(data.Answer))) throw new Error("browser_dns_unavailable");
    for (const answer of data.Answer ?? []) if (answer.type === 1 || answer.type === 28) {
      if (typeof answer.data !== "string" || !publicAddress(answer.data)) throw new Error("browser_private_address"); addresses++;
    }
  }
  if (!addresses) throw new Error("browser_dns_unavailable");
}

/** The browser itself has an empty native allowlist. Only these fulfilled
 * responses enter it; un-intercepted workers/popups cannot bypass this proxy. */
export async function proxyBrowserRequest(input: BrowserProxyRequest, hosts: string[], budget: BrowserNetworkBudget, signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<BrowserProxyResponse> {
  const url = browserUrl(input.url, hosts);
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(input.method)
    || encoder.encode(input.body ?? "").length > BROWSER_NETWORK_LIMITS.requestBytes) throw new Error("browser_request_blocked");
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers)) if (!/^(?:host|connection|content-length|accept-encoding|upgrade|proxy-|cf-|sec-websocket)/i.test(key)) headers.set(key, value);
  if (input.headers.upgrade || /multipart\/form-data/i.test(headers.get("content-type") ?? "")) throw new Error("browser_request_blocked");
  headers.set("accept-encoding", "identity");
  await budget.assertActive(); await budget.reserve(BROWSER_NETWORK_LIMITS.responseBytes);
  let consumed: number = BROWSER_NETWORK_LIMITS.responseBytes;
  try {
    await assertPublicHost(new URL(url).hostname, requestFetch); await budget.assertActive();
    const response = await requestFetch(url, { method: input.method, headers, body: ["GET", "HEAD"].includes(input.method) ? undefined : input.body,
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (response.status === 101 || /attachment/i.test(response.headers.get("content-disposition") ?? "") || /(?:application\/octet-stream|text\/event-stream)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel().catch(() => {}); throw new Error("browser_response_blocked"); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      try { if (location) browserUrl(new URL(location, url).href, hosts); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    }
    const body = await readBounded(response, BROWSER_NETWORK_LIMITS.responseBytes); consumed = body.length;
    await budget.assertActive();
    const outgoing: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => { if (!/^(?:content-length|content-encoding|transfer-encoding|connection|alt-svc)$/i.test(key)) outgoing[key] = value; });
    const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing["set-cookie"] = cookies;
    return { status: response.status, headers: outgoing, body };
  } finally { if (consumed < BROWSER_NETWORK_LIMITS.responseBytes) await budget.refund(BROWSER_NETWORK_LIMITS.responseBytes - consumed); }
}
