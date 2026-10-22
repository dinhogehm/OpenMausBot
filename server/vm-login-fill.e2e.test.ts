// The real fill_login path for a Local VM, end to end through real child processes: a stand-in runtime CLI plays
// `docker exec` into a VM (the accessibility probe and Cua Driver's MCP), keeping the page in a JSON file. Nothing reaches
// a real container. It proves where the password travels: Cua Driver's stdin only, never argv or the probe.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { loginPlace } from "../shared/logins.ts";
import { fillLoginOn } from "./login-fill.ts";
import { cuaMcpInput, firefoxProbe, vmLoginPage } from "./vm-firefox-login.ts";
import { perBotLocalVmTarget, type Runtime } from "./container-computer.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// Obvious fakes only.
const PASSWORD = "fake-E2E-VM-Passw0rd!";
const USERNAME = "alice@example.com";

const dir = mkdtempSync(join(tmpdir(), "omb-vm-fill-e2e-"));
afterAll(() => removeTempDir(dir));
const state = join(dir, "page.json");
const log = join(dir, "calls.jsonl");
const runtime = join(dir, "fake-runtime");

writeFileSync(runtime, `#!${process.execPath}
const fs = require("node:fs");
const state = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
const write = (page) => fs.writeFileSync(state, JSON.stringify(page));
let input = "";
const record = (kind, extra) => fs.appendFileSync(log, JSON.stringify({ kind, args, ...extra }) + "\\n");
if (args[0] !== "exec" || !args.includes("-i")) { record("other"); process.exit(3); }
if (args.includes("/usr/bin/python3")) {
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => {
    record("probe", { stdin: input });
    const request = JSON.parse(input);
    const page = read();
    const base = { href: page.href, active: page.active, pid: 91, title: "Sign in — Mozilla Firefox" };
    const box = (name) => page.boxes[name];
    let out = base;
    if (request.op === "find") out = { ...base, username: "username" in page.boxes, password: "password" in page.boxes, code: 0 };
    else if (request.op === "check") out = { ...base, ...Object.fromEntries(Object.entries(page.boxes).map(([k, v]) => [k, v.length > 0])) };
    else if (request.op === "focus") {
      if (request.name === "username" && box("username") === request.keep) out = { ...base, focused: true, same: true, empty: false };
      else { page.focused = request.name; write(page); out = { ...base, focused: true, same: false, empty: !box(request.name) }; }
    } else if (request.op === "length") out = { ...base, focused: page.focused === request.name, length: [...(box(request.name) || "")].length };
    process.stdout.write(JSON.stringify(out) + "\\n");
  });
} else if (args.includes("mcp")) {
  record("cua");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const message = JSON.parse(line);
      fs.appendFileSync(log + ".cua-stdin", line + "\\n");
      if (message.id === undefined) continue;
      let result = { content: [{ type: "text", text: "ok" }] };
      if (message.method === "initialize") result = { capabilities: { tools: {} } };
      if (message.method === "tools/call") {
        const { name, arguments: a } = message.params;
        const page = read();
        if (name === "type_text" && page.focused) page.boxes[page.focused] += a.text;
        if (name === "press_key" && a.key === "BackSpace" && page.focused) page.boxes[page.focused] = "";
        write(page);
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    }
  });
} else { record("other"); process.exit(3); }
`, { mode: 0o755 });

it.skipIf(process.platform === "win32")("fills Firefox on a Local VM through the probe and Cua Driver, with the password only on Cua Driver's stdin", async () => {
  writeFileSync(state, JSON.stringify({ href: "https://accounts.example.com/login", active: true, boxes: { username: "", password: "" }, focused: null }));
  const target = perBotLocalVmTarget("e2e-bot");
  const run = runtime as unknown as Runtime;
  const page = vmLoginPage({ probe: firefoxProbe(run, target), input: cuaMcpInput(run, target), stillAllowed: () => true });
  let outcome;
  try {
    outcome = await fillLoginOn({
      candidates: async (host) => host === "accounts.example.com" ? [{
        id: "login-1", ...loginPlace(host), username: USERNAME, source: "settings", secrets: async () => ({ password: PASSWORD, totp: null }),
      }] : [],
      available: async () => [{ ...loginPlace("accounts.example.com"), username: USERNAME }],
    }, page, { remember: () => undefined });
  } finally {
    page.close();
  }
  expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
  expect(JSON.parse(readFileSync(state, "utf8")).boxes).toEqual({ username: USERNAME, password: PASSWORD });

  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; args: string[]; stdin?: string });
  expect(calls.filter((call) => call.kind === "other")).toEqual([]);
  // One Cua Driver session for the whole fill, entered as the guest user over `exec -i`.
  const cua = calls.filter((call) => call.kind === "cua");
  expect(cua).toHaveLength(1);
  expect(cua[0]!.args).toEqual(expect.arrayContaining(["exec", "-i", "-u", "cua", target.containerName, "mcp", "--socket"]));
  for (const call of calls) {
    expect(call.args.join(" ")).not.toContain(PASSWORD);
    if (call.kind === "probe") expect(call.stdin).not.toContain(PASSWORD);
  }
  expect(readFileSync(`${log}.cua-stdin`, "utf8")).toContain(JSON.stringify(PASSWORD));
  expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
});
