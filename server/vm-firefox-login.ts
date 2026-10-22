// fill_login on a Local VM. The desktop's browser is Firefox ESR, which speaks neither CDP nor agent-browser, so:
// - the page and its login boxes are found through Firefox's own accessibility tree (AT-SPI, read inside the VM by a
//   small Python script). The page address is the top document's DocURL, which a page cannot fake and an address-bar
//   draft does not change; boxes inside another document (an iframe) are never used.
// - every value is typed by Cua Driver (`type_text` over its MCP stdio inside the container), as real key presses.
// The password and one-time code travel only on that MCP session's stdin: never on a command line, in the Python
// script, a log, or anything the bot sees. Each answer back is an address, booleans and lengths.
import { spawn } from "node:child_process";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { CUA_SOCKET, DISPLAY, cuaExecArgs, type LocalVmTarget, type Runtime } from "./container-computer.ts";
import type { LoginFieldsFound, LoginPage } from "./login-fill.ts";

export const FIREFOX_A11Y_SCRIPT = String.raw`import json, re, sys, time
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, Gio, GLib
except Exception:
    print(json.dumps({"error": "no_atspi"}))
    sys.exit(0)

STRONG = re.compile(r"(?:^|[^a-z])t?otp|2fa|mfa|two[-_ ]?factor|one[-_ ]?time")
WEAK = re.compile(r"verif|security[-_ ]?code|auth\w*[-_ ]?code|passcode|\bcode\b|c[oó]digo")
NOT_CODE = re.compile(r"zip|postal|promo|coupon|country|area|invite|referr|\bcep\b")
USER = re.compile(r"user|e-?mail|login|account|identifier|phone|mobile|usu[aá]rio|celular|\bcpf\b")
SECOND = re.compile(r"new|confirm|repeat|again|nova|confirme|repita")
S = Atspi.StateType

def enable():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                      GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
                      None, Gio.DBusCallFlags.NONE, 2000, None)
    except Exception:
        pass

def role(n):
    try: return n.get_role_name() or ""
    except Exception: return ""

def kids(n):
    try: count = n.get_child_count()
    except Exception: return []
    out = []
    for i in range(min(count, 2000)):
        try: c = n.get_child_at_index(i)
        except Exception: c = None
        if c is not None: out.append(c)
    return out

def has(n, state):
    try: return n.get_state_set().contains(state)
    except Exception: return False

def attrs(n):
    try: return dict(n.get_attributes() or {})
    except Exception: return {}

def doc_url(doc):
    for getter in ("get_attribute_value", "get_document_attribute_value"):
        try:
            value = getattr(Atspi.Document, getter)(doc, "DocURL")
            if value: return value
        except Exception:
            pass
    return None

def frames():
    desk = Atspi.get_desktop(0)
    out = []
    for app in kids(desk):
        try: name = (app.get_name() or "").lower()
        except Exception: name = ""
        if "firefox" not in name: continue
        try: pid = app.get_process_id()
        except Exception: pid = 0
        for frame in kids(app):
            if role(frame) == "frame": out.append((pid, frame))
    return out

def showing_doc(frame):
    stack = [(frame, 0)]
    while stack:
        node, depth = stack.pop(0)
        if depth > 30: continue
        if role(node) == "document web":
            if has(node, S.SHOWING): return node
            continue
        stack.extend((c, depth + 1) for c in kids(node))
    return None

def page():
    found = [(pid, f) for pid, f in frames()]
    if not found: return {"error": "no_firefox"}
    active = [(pid, f) for pid, f in found if has(f, S.ACTIVE)]
    if len(active) == 1: pid, frame, is_active = active[0][0], active[0][1], True
    elif not active and len(found) == 1: pid, frame, is_active = found[0][0], found[0][1], False
    else: return {"error": "ambiguous_window"}
    doc = showing_doc(frame)
    if doc is None: return {"error": "no_page"}
    try: title = frame.get_name() or ""
    except Exception: title = ""
    return {"pid": pid, "frame": frame, "doc": doc, "href": doc_url(doc), "active": is_active, "title": title}

def fields(doc):
    out = []
    def walk(node, depth, form):
        if depth > 80: return
        r = role(node)
        if r == "document web" and node is not doc: return
        if r == "form": form = node
        if r in ("entry", "password text", "spin button"):
            out.append((node, form))
        for c in kids(node): walk(c, depth + 1, form)
    walk(doc, 0, None)
    return out

def usable(node):
    if not (has(node, S.SHOWING) and has(node, S.VISIBLE) and has(node, S.ENABLED) and has(node, S.EDITABLE)): return False
    if has(node, S.READ_ONLY): return False
    try:
        ext = Atspi.Component.get_extents(node, Atspi.CoordType.SCREEN)
        if ext.width <= 0 or ext.height <= 0: return False
    except Exception:
        pass
    return True

def hint(node):
    a = attrs(node)
    try: name = node.get_name() or ""
    except Exception: name = ""
    try: desc = node.get_description() or ""
    except Exception: desc = ""
    return " ".join([name, desc, a.get("id", ""), a.get("class", ""), a.get("name", ""), a.get("placeholder", "")]).lower()

def kind(node):
    r = role(node)
    t = attrs(node).get("text-input-type", "")
    if r == "password text": return "password"
    if r == "spin button" or t == "number": return "number"
    if t in ("", "text", "email", "tel"): return "plain:" + t
    return t

def classify(doc):
    rows = [(n, f) for n, f in fields(doc) if usable(n)]
    def is_code(n):
        k, h = kind(n), hint(n)
        if NOT_CODE.search(h): return False
        if (k.startswith("plain") or k in ("number", "password")) and STRONG.search(h): return True
        return (k.startswith("plain") or k == "number") and bool(WEAK.search(h))
    codes = [n for n, _ in rows if is_code(n)]
    rest = [(n, f) for n, f in rows if n not in codes]
    passwords = [(n, f) for n, f in rest if kind(n) == "password"]
    password = next(((n, f) for n, f in passwords if not SECOND.search(hint(n))), passwords[0] if passwords else None)
    plain = lambda n: kind(n).startswith("plain") and kind(n) != "plain:search"
    user_like = lambda n: kind(n) == "plain:email" or (plain(n) and bool(USER.search(hint(n))))
    username = None
    if password:
        pnode, pform = password
        order = [n for n, _ in rows]
        scope = [n for n, f in rest if n is not pnode and plain(n) and f is pform]
        before = [n for n in scope if order.index(n) < order.index(pnode)]
        liked = [n for n in before if user_like(n)]
        username = liked[-1] if liked else (before[-1] if before else next((n for n in scope if user_like(n)), None))
    else:
        username = next((n for n, _ in rest if user_like(n)), None)
    picked = {}
    if username is not None: picked["username"] = username
    if password: picked["password"] = password[0]
    if codes: picked["code0"] = codes[0]
    return picked

def text_of(n):
    try: return Atspi.Text.get_text(n, 0, -1) or ""
    except Exception: return ""

def length_of(n):
    try: return int(Atspi.Text.get_character_count(n))
    except Exception: return -1

def main():
    request = json.loads(sys.stdin.read() or "{}")
    op = request.get("op")
    enable()
    current = page()
    if "error" in current:
        print(json.dumps(current)); return
    base = {"href": current["href"], "active": current["active"], "pid": current["pid"], "title": current["title"]}
    if op == "url":
        print(json.dumps(base)); return
    picked = classify(current["doc"])
    if op == "find":
        base.update({"username": "username" in picked, "password": "password" in picked, "code": 1 if "code0" in picked else 0})
        print(json.dumps(base)); return
    name = request.get("name")
    if op == "check":
        base.update({k: length_of(v) > 0 for k, v in picked.items()})
        print(json.dumps(base)); return
    node = picked.get(name)
    if node is None:
        base.update({"focused": False, "same": False, "length": -1, "empty": True})
        print(json.dumps(base)); return
    if op == "focus":
        keep = request.get("keep")
        if isinstance(keep, str) and name == "username" and text_of(node) == keep:
            base.update({"focused": True, "same": True, "empty": False})
            print(json.dumps(base)); return
        try: Atspi.Component.grab_focus(node)
        except Exception: pass
        for _ in range(10):
            if has(node, S.FOCUSED): break
            time.sleep(0.05)
        base.update({"focused": has(node, S.FOCUSED), "same": False, "empty": length_of(node) <= 0})
        print(json.dumps(base)); return
    if op == "length":
        base.update({"focused": has(node, S.FOCUSED), "length": length_of(node)})
        print(json.dumps(base)); return
    print(json.dumps({"error": "bad_op"}))

try:
    main()
except Exception as error:
    print(json.dumps({"error": "failed", "detail": type(error).__name__}))
`;

const SESSION_BUS = "unix:path=/run/user/1000/bus";
const PROBE_TIMEOUT_MS = 20_000;
const CUA_CALL_TIMEOUT_MS = 30_000;
const STDOUT_LIMIT = 256 * 1024;

export interface ProcessResult { code: number | null; stdout: string; stderr: string }

/** Runs a runtime CLI with `input` on stdin only. */
export type StdinRunner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<ProcessResult>;

export const runWithStdin: StdinRunner = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const resolved = resolveCliSpawn(command, args);
  const child = spawn(resolved.command, resolved.args, {
    shell: false,
    env: { ...process.env, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the Local VM did not answer in time")); }, timeoutMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => { if (stdout.length < STDOUT_LIMIT) stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += String(chunk); });
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
});

export function firefoxProbeArgs(container: string): string[] {
  return [
    "exec", "-i", "-u", "cua",
    "-e", "HOME=/home/cua",
    "-e", `DISPLAY=${DISPLAY}`,
    "-e", `DBUS_SESSION_BUS_ADDRESS=${SESSION_BUS}`,
    container,
    "/usr/bin/python3", "-W", "ignore", "-c", FIREFOX_A11Y_SCRIPT,
  ];
}

export interface FirefoxProbeAnswer {
  error?: string;
  href?: string | null;
  active?: boolean;
  pid?: number;
  title?: string;
  username?: boolean;
  password?: boolean;
  code?: number;
  code0?: boolean;
  focused?: boolean;
  same?: boolean;
  empty?: boolean;
  length?: number;
}

export type FirefoxProbe = (request: { op: "url" | "find" | "check" | "focus" | "length"; name?: string; keep?: string }) => Promise<FirefoxProbeAnswer>;

export function firefoxProbe(runtime: Runtime, target: LocalVmTarget, run: StdinRunner = runWithStdin): FirefoxProbe {
  return async (request) => {
    const result = await run(runtime, firefoxProbeArgs(target.containerName), JSON.stringify(request), PROBE_TIMEOUT_MS);
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try {
      const parsed = JSON.parse(line) as FirefoxProbeAnswer;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
    }
    return { error: result.code === 0 ? "unreadable" : "failed" };
  };
}

/** Cua Driver's own MCP over stdio in the container: values ride its stdin, one JSON-RPC message per line. */
export interface CuaInput {
  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; structured?: Record<string, unknown> }>;
  close(): void;
}

export type CuaInputFactory = () => Promise<CuaInput>;

export function cuaMcpInput(runtime: Runtime, target: LocalVmTarget): CuaInputFactory {
  return async () => {
    const resolved = resolveCliSpawn(runtime, cuaExecArgs(["mcp", "--socket", CUA_SOCKET], { container: target.containerName, interactive: true }));
    const child = spawn(resolved.command, resolved.args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin.on("error", () => undefined);
    let buffer = "";
    let nextId = 1;
    const waiting = new Map<number, (message: Record<string, unknown> | null) => void>();
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const id = typeof message.id === "number" ? message.id : null;
          if (id !== null) { waiting.get(id)?.(message); waiting.delete(id); }
        } catch {
        }
      }
    });
    const settleAll = () => { for (const done of waiting.values()) done(null); waiting.clear(); };
    child.on("close", settleAll);
    child.on("error", settleAll);
    const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown> | null>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, CUA_CALL_TIMEOUT_MS);
      timer.unref?.();
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    const hello = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openmausbot-fill-login", version: "1" },
    });
    if (!hello || hello.error) {
      child.kill("SIGKILL");
      throw new Error("Cua Driver did not answer in the Local VM");
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return {
      async call(name, args) {
        const answer = await request("tools/call", { name, arguments: args });
        const result = answer?.result as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
        return { ok: Boolean(result) && result?.isError !== true && !answer?.error, ...(result?.structuredContent ? { structured: result.structuredContent } : {}) };
      },
      close() {
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      },
    };
  };
}

export interface VmLoginPageDeps {
  probe: FirefoxProbe;
  input: CuaInputFactory;
  /** False once the turn lost the VM or the person took control: nothing more is typed. */
  stillAllowed: () => boolean;
}

export interface VmLoginPage extends LoginPage {
  /** Why the last step failed, in words for the bot; never a value. */
  problem(): string | null;
  close(): void;
}

const PROBLEMS: Record<string, string> = {
  no_atspi: "This Local VM's desktop is older than fill_login needs. Ask the person to recreate the Local VM (App Settings → Local VM), or call request_sign_in.",
  no_firefox: "Firefox is not open on the Local VM. Open the site's login page in Firefox there, then call fill_login.",
  ambiguous_window: "Several Firefox windows are open and none is in front. Bring the window with the login page to the front, then call fill_login.",
  no_page: "Firefox on the Local VM shows no page. Open the site's login page, then call fill_login.",
};

/** Firefox on a Local VM as a LoginPage. One Cua Driver session serves every key press of one fill_login call. */
export function vmLoginPage(deps: VmLoginPageDeps): VmLoginPage {
  let problem: string | null = null;
  let session: CuaInput | null = null;
  let activated = false;
  const cua = async () => (session ??= await deps.input());
  const answered = (answer: FirefoxProbeAnswer): boolean => {
    if (!answer.error) return true;
    problem = PROBLEMS[answer.error] ?? "Firefox on the Local VM did not answer. Call request_sign_in instead.";
    return false;
  };
  /** Typing goes to the desktop's focused window, so Firefox's must be the one in front. */
  const front = async (): Promise<boolean> => {
    const now = await deps.probe({ op: "url" });
    if (!answered(now)) return false;
    if (now.active) return true;
    if (activated || typeof now.pid !== "number") return false;
    activated = true;
    const input = await cua();
    const listed = await input.call("list_windows", { pid: now.pid });
    const windows = Array.isArray(listed.structured?.windows) ? listed.structured.windows as Array<{ window_id?: unknown; title?: unknown; pid?: unknown }> : [];
    const mine = windows.filter((window) => window.pid === now.pid && typeof window.window_id === "number");
    const exact = mine.filter((window) => window.title === now.title);
    const chosen = exact.length === 1 ? exact[0] : mine.length === 1 ? mine[0] : null;
    if (!chosen) return false;
    await input.call("bring_to_front", { pid: now.pid, window_id: chosen.window_id });
    const after = await deps.probe({ op: "url" });
    return answered(after) && after.active === true;
  };
  const clear = async () => {
    const input = await cua();
    await input.call("hotkey", { keys: ["ctrl", "a"], scope: "desktop" });
    await input.call("press_key", { key: "BackSpace", scope: "desktop" });
  };
  return {
    problem: () => problem,
    close() { session?.close(); session = null; },
    async url() {
      const answer = await deps.probe({ op: "url" });
      if (!answered(answer)) return null;
      return typeof answer.href === "string" ? answer.href : null;
    },
    async find(): Promise<LoginFieldsFound | null> {
      const answer = await deps.probe({ op: "find" });
      if (!answered(answer)) return null;
      return { href: answer.href, username: answer.username === true, password: answer.password === true, code: answer.code === 1 ? 1 : 0 };
    },
    async focus(name, keep) {
      if (!deps.stillAllowed()) { problem = "The Local VM is no longer yours to type on (the person took control, or the turn ended)."; return null; }
      if (!(await front())) {
        problem ??= "Firefox's window on the Local VM is not in front, so nothing was typed. Bring it to the front, then call fill_login again.";
        return null;
      }
      const answer = await deps.probe({ op: "focus", name, ...(keep !== undefined ? { keep } : {}) });
      if (!answered(answer)) return null;
      if (answer.focused === true && answer.same !== true && answer.empty === false) await clear();
      return { href: answer.href, focused: answer.focused === true, same: answer.same === true };
    },
    async type(name, text) {
      if (!deps.stillAllowed()) { problem = "The Local VM is no longer yours to type on (the person took control, or the turn ended)."; return false; }
      const input = await cua();
      const typed = await input.call("type_text", { text, scope: "desktop" });
      const after = await deps.probe({ op: "length", name });
      // A key the desktop's keyboard map cannot make is dropped silently, so count what landed; never leave a part behind.
      if (!typed.ok || after.error || after.focused !== true || after.length !== [...text].length) {
        if (!after.error && after.focused === true) await clear();
        problem = "Some characters could not be typed on the Local VM's keyboard, so the box was emptied again. Call request_sign_in so the person signs in.";
        return false;
      }
      return true;
    },
    async check() {
      const answer = await deps.probe({ op: "check" });
      if (answer.error) return null;
      const out: Record<string, boolean> = {};
      for (const name of ["username", "password", "code0"]) if (typeof (answer as Record<string, unknown>)[name] === "boolean") out[name] = (answer as Record<string, boolean>)[name]!;
      return out;
    },
  };
}
