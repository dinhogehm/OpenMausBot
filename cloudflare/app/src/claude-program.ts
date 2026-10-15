import { stripVTControlCharacters } from "node:util";
import { CLAUDE_CLI_VERSION, CLAUDE_LIMITS, type ClaudeInferenceInput, type ClaudeInferenceResult, type ClaudeAuthMethod } from "./claude-types.ts";

const encoder = new TextEncoder();
export const CLAUDE_PREFIX = ["/usr/bin/setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/local/bin/claude"];
export const CLAUDE_ENV = {
  HOME: "/home/claude", CLAUDE_CONFIG_DIR: "/home/claude/.claude", BROWSER: "/bin/true",
  PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1",
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLAUDE_LIMITS.outputTokens),
};
export const claudeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function boundedClaudeText(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || !value.isWellFormed() || (!empty && !value.trim()) || encoder.encode(value).length > max) throw new Error("claude_invalid_input");
  return value;
}
export function validateClaudeInput(input: ClaudeInferenceInput): void {
  if (![input.organizationId, input.userId, input.runId, input.stepId].every(claudeId) || !Number.isSafeInteger(input.connectionVersion) || input.connectionVersion < 1
    || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 30 * 60_000
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(input.model)) throw new Error("claude_invalid_input");
  boundedClaudeText(input.prompt, CLAUDE_LIMITS.promptBytes);
  boundedClaudeText(input.instructions, CLAUDE_LIMITS.instructionsBytes);
  if (!input.schema || Array.isArray(input.schema) || typeof input.schema !== "object" || input.schema.type !== "object") throw new Error("claude_invalid_input");
  const schema = boundedClaudeText(JSON.stringify(input.schema), CLAUDE_LIMITS.schemaBytes);
  // Schemas are supplied by the coordinator; never resolve external documents.
  if (/"\$(?:ref|dynamicRef)"\s*:\s*"(?!#)/.test(schema)) throw new Error("claude_invalid_input");
}
export function claudeInferenceCommand(input: ClaudeInferenceInput): string[] {
  validateClaudeInput(input);
  return [...CLAUDE_PREFIX, "-p", "--output-format", "json", "--json-schema", JSON.stringify(input.schema),
    "--safe-mode", "--restricted", "--tools", "", "--disallowedTools", "mcp__*", "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--no-chrome",
    "--max-turns", "1", "--model", input.model, "--append-system-prompt", input.instructions];
}
export function claudeLoginPrompt(output: string): string | null {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).slice(0, -1);
  for (const line of lines) {
    const candidate = /https:\/\/[^\s<>]+/.exec(line)?.[0].replace(/[),.;]+$/, "");
    if (!candidate || candidate.length > 8192) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash
        && ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)
        && url.pathname === "/oauth/authorize") return url.href;
    } catch { /* Ignore CLI text that is not an authorization URL. */ }
  }
  return null;
}
export function claudeLoginCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_#.:-]{8,1024}$/.test(value.trim())) throw new Error("claude_invalid_code");
  return value.trim();
}
export function parseClaudeAuth(output: string, exitCode: number): { authenticated: boolean; authMethod?: ClaudeAuthMethod } {
  try {
    const data = JSON.parse(output); const authenticated = exitCode === 0 && data.loggedIn === true;
    const authMethod = ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"].includes(data.authMethod) ? data.authMethod as ClaudeAuthMethod : undefined;
    return { authenticated, ...(authenticated && authMethod ? { authMethod } : {}) };
  } catch { return { authenticated: false }; }
}
export function parseClaudeResult(output: string, exitCode: number): ClaudeInferenceResult {
  try {
    const data = JSON.parse(output) as Record<string, unknown>;
    if (exitCode !== 0 || data.type !== "result" || data.subtype !== "success" || data.is_error !== false
      || !data.structured_output || typeof data.structured_output !== "object" || Array.isArray(data.structured_output)) throw new Error();
    boundedClaudeText(JSON.stringify(data.structured_output), CLAUDE_LIMITS.resultBytes);
    const usage = data.usage as Record<string, unknown>;
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) throw new Error();
    const counts = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0] as number[];
    if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error();
    const tokens = counts.reduce((a, b) => a + b, 0);
    if (tokens < 1 || tokens > 1_000_000) throw new Error();
    return { structuredOutput: data.structured_output, tokens, cliVersion: CLAUDE_CLI_VERSION };
  } catch { throw new Error("claude_invalid_result"); }
}
export async function claudeFingerprint(input: unknown): Promise<string> {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)])) : value;
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(sort(input))));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
