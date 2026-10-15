import { HttpError } from "./http";
import { BROWSER_LIMITS, type BrowserAction, type BrowserRun, type BrowserRunInput, type BrowserRunStatus } from "./browser-types";
import type { MemberRole } from "./organizations";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new HttpError(400, "invalid_browser_task");
  return value;
}
export function browserHost(value: unknown): string {
  const host = text(value, 253).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|arpa|home|lan)$/.test(host)) throw new HttpError(400, "invalid_browser_host");
  return host;
}
export function browserUrl(value: unknown, hosts: string[]): string {
  const raw = text(value, 2048); let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "invalid_browser_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(browserHost(url.hostname))) throw new HttpError(400, "invalid_browser_url");
  return url.href;
}
export function parseBrowserInput(body: Record<string, unknown>): BrowserRunInput {
  const requestId = text(body.requestId, 36); const task = body.task;
  if (!uuid.test(requestId) || typeof task !== "string" || !task.isWellFormed() || !task.trim() || task.length > 4000 || task.includes("\0")
    || !Array.isArray(body.allowedHosts) || body.allowedHosts.length < 1 || body.allowedHosts.length > 10
    || !["openai", "anthropic", "openrouter"].includes(String(body.provider))) throw new HttpError(400, "invalid_browser_task");
  const allowedHosts = [...new Set(body.allowedHosts.map(browserHost))].sort();
  if (allowedHosts.length !== body.allowedHosts.length) throw new HttpError(400, "invalid_browser_host");
  const model = text(body.model, 120);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/.test(model)) throw new HttpError(400, "invalid_browser_task");
  let agent: BrowserRunInput["agent"];
  if (body.agent !== undefined) {
    const raw = body.agent as Record<string, unknown>;
    if (!raw || !Number.isSafeInteger(raw.catalogVersion) || Number(raw.catalogVersion) < 1 || typeof raw.profileId !== "string" || !uuid.test(raw.profileId)) throw new HttpError(400, "invalid_agent_selection");
    agent = { catalogVersion: Number(raw.catalogVersion), profileId: raw.profileId };
  }
  return { requestId, task: task.trim(), initialUrl: browserUrl(body.initialUrl, allowedHosts), allowedHosts, provider: body.provider as BrowserRunInput["provider"], model, ...(agent ? { agent } : {}) };
}
export function parseBrowserAction(value: unknown, hosts: string[]): BrowserAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_invalid_action");
  const action = value as Record<string, unknown>;
  if (action.kind === "navigate") return { kind: "navigate", url: browserUrl(action.url, hosts) };
  if (action.kind === "click" && Number.isInteger(action.x) && Number.isInteger(action.y) && Number(action.x) >= 0 && Number(action.x) < BROWSER_LIMITS.width && Number(action.y) >= 0 && Number(action.y) < BROWSER_LIMITS.height) return { kind: "click", x: Number(action.x), y: Number(action.y) };
  if (action.kind === "type" && typeof action.text === "string" && action.text.isWellFormed() && action.text.length > 0 && action.text.length <= 2000 && !action.text.includes("\0")) return { kind: "type", text: action.text };
  if (action.kind === "press" && ["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"].includes(String(action.key))) return { kind: "press", key: action.key as Extract<BrowserAction, { kind: "press" }>["key"] };
  if (action.kind === "scroll" && ["up", "down"].includes(String(action.direction)) && Number.isInteger(action.amount) && Number(action.amount) >= 1 && Number(action.amount) <= 800) return { kind: "scroll", direction: action.direction as "up" | "down", amount: Number(action.amount) };
  if (action.kind === "finish" && typeof action.completed === "boolean" && typeof action.summary === "string" && action.summary.isWellFormed() && action.summary.trim() && action.summary.length <= 4000) return { kind: "finish", completed: action.completed, summary: action.summary };
  throw new Error("browser_invalid_action");
}
export const browserTerminal = (status: BrowserRunStatus) => ["completed", "failed", "canceled", "interrupted"].includes(status);
export function browserView(run: BrowserRun, userId: string, role: MemberRole): BrowserRun {
  return { ...run, canApprove: role !== "member" && run.status === "pending_approval", canCancel: !browserTerminal(run.status) && (role !== "member" || run.createdBy === userId) };
}
