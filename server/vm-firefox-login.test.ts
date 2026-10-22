import { describe, expect, it } from "vitest";

import { fillLoginOn, type FillCandidate } from "./login-fill.ts";
import { FIREFOX_A11Y_SCRIPT, firefoxProbeArgs, vmLoginPage, type CuaInput, type FirefoxProbe, type FirefoxProbeAnswer } from "./vm-firefox-login.ts";
import { parseTotpKey, totpCode } from "./totp.ts";
import { loginPlace } from "../shared/logins.ts";

// Obvious fakes only.
const PASSWORD = "fake-VM-Passw0rd!";
const KEY = parseTotpKey("JBSWY3DPEHPK3PXP")!;
const NOW = 1_700_000_010_000;

type Field = "username" | "password" | "code0";

/** Firefox on a Local VM as AT-SPI and Cua Driver would see it: one active window, boxes with text, one focused box. */
class FakeVmFirefox {
  href = "https://accounts.example.com/login";
  active = true;
  boxes: Partial<Record<Field, string>> = { username: "", password: "" };
  focused: Field | null = null;
  /** Characters this desktop's keyboard map cannot make. */
  untypable = new Set<string>();
  probes: Array<Record<string, unknown>> = [];
  cuaCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Run after each type_text, to move the page mid-fill. */
  afterType?: () => void;

  probe: FirefoxProbe = async (request) => {
    this.probes.push({ ...request });
    const base: FirefoxProbeAnswer = { href: this.href, active: this.active, pid: 91, title: "Sign in — Mozilla Firefox" };
    if (request.op === "url") return base;
    if (request.op === "find") return { ...base, username: "username" in this.boxes, password: "password" in this.boxes, code: "code0" in this.boxes ? 1 : 0 };
    if (request.op === "check") return { ...base, ...Object.fromEntries(Object.entries(this.boxes).map(([name, text]) => [name, Boolean(text)])) };
    const name = request.name as Field;
    if (!(name in this.boxes)) return { ...base, focused: false, same: false, empty: true, length: -1 };
    if (request.op === "focus") {
      if (name === "username" && typeof request.keep === "string" && this.boxes.username === request.keep) return { ...base, focused: true, same: true, empty: false };
      this.focused = name;
      return { ...base, focused: true, same: false, empty: !this.boxes[name] };
    }
    return { ...base, focused: this.focused === name, length: [...(this.boxes[name] ?? "")].length };
  };

  input = async (): Promise<CuaInput> => ({
    call: async (name, args) => {
      this.cuaCalls.push({ name, args });
      if (name === "type_text" && this.focused) {
        this.boxes[this.focused] = (this.boxes[this.focused] ?? "") + [...String(args.text)].filter((char) => !this.untypable.has(char)).join("");
        this.afterType?.();
      }
      if (name === "press_key" && this.focused && args.key === "BackSpace") this.boxes[this.focused] = "";
      if (name === "list_windows") return { ok: true, structured: { windows: [{ pid: 91, window_id: 8388651, title: "Sign in — Mozilla Firefox" }] } };
      if (name === "bring_to_front") this.active = true;
      return { ok: true };
    },
    close: () => undefined,
  });
}

function setup(firefox: FakeVmFirefox, saved: Array<{ host: string; username: string; totp?: boolean }>, allowed = () => true) {
  const remembered: Array<[string, string]> = [];
  const candidates = async (host: string): Promise<FillCandidate[]> => saved.filter((login) => login.host === host).map((login, index) => ({
    id: `login-${index}`, ...loginPlace(login.host), username: login.username, source: "settings",
    secrets: async () => ({ password: PASSWORD, totp: login.totp ? KEY : null }),
  }));
  const page = vmLoginPage({ probe: firefox.probe, input: firefox.input, stillAllowed: allowed });
  const fill = (username?: string) => fillLoginOn({
    username, candidates, available: async () => saved.map(({ host, username: name }) => ({ ...loginPlace(host), username: name })),
  }, page, { remember: (value, kind) => { remembered.push([kind, value]); }, now: () => NOW, sleep: async () => undefined });
  return { page, fill, remembered };
}

function expectNoSecretInProbes(firefox: FakeVmFirefox, secrets: string[]) {
  const probes = JSON.stringify(firefox.probes);
  for (const secret of secrets) expect(probes).not.toContain(secret);
}

describe("fill_login on a Local VM's Firefox", () => {
  it("types the username and password as key presses on the exact host, and the probe never carries a secret", async () => {
    const firefox = new FakeVmFirefox();
    const { fill, page, remembered } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, host: "accounts.example.com", filled: ["username", "password"] });
    expect(firefox.boxes).toEqual({ username: "alice@example.com", password: PASSWORD });
    expect(page.problem()).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    expect(remembered).toContainEqual(["password", PASSWORD]);
    expectNoSecretInProbes(firefox, [PASSWORD]);
    expect(firefox.cuaCalls.filter((call) => call.name === "type_text").map((call) => call.args)).toEqual([
      { text: "alice@example.com", scope: "desktop" },
      { text: PASSWORD, scope: "desktop" },
    ]);
  });

  it("never fills a subdomain, another site, or a page that is not https", async () => {
    for (const href of ["https://evil.example.com/login", "https://accounts.example.com.evil.test/", "http://accounts.example.com/login", "about:blank"]) {
      const firefox = new FakeVmFirefox();
      firefox.href = href;
      const { fill } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }]);
      expect((await fill()).ok).toBe(false);
      expect(firefox.cuaCalls.some((call) => call.name === "type_text")).toBe(false);
    }
  });

  it("stops typing when the page moves to another host mid-fill", async () => {
    const firefox = new FakeVmFirefox();
    firefox.afterType = () => { firefox.href = "https://phish.example.net/"; };
    const { fill } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    const outcome = await fill();
    expect(firefox.boxes.password).toBe("");
    expect(firefox.cuaCalls.filter((call) => call.name === "type_text")).toHaveLength(1);
    expect(outcome.text).not.toContain(PASSWORD);
  });

  it("brings Firefox's window to the front before typing, since keys go to the focused window", async () => {
    const firefox = new FakeVmFirefox();
    firefox.active = false;
    const { fill } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    expect((await fill()).ok).toBe(true);
    const names = firefox.cuaCalls.map((call) => call.name);
    expect(names.indexOf("bring_to_front")).toBeLessThan(names.indexOf("type_text"));
    expect(firefox.cuaCalls.find((call) => call.name === "bring_to_front")?.args).toEqual({ pid: 91, window_id: 8388651 });
  });

  it("empties the box again when the desktop's keyboard cannot type every character, and says so", async () => {
    const firefox = new FakeVmFirefox();
    firefox.untypable = new Set(["!"]);
    const { fill, page } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    const outcome = await fill();
    expect(firefox.boxes.password).toBe("");
    expect(outcome.filled).toEqual(["username"]);
    expect(page.problem()).toMatch(/could not be typed.*request_sign_in/);
  });

  it("types nothing once the person takes control or the turn loses the VM", async () => {
    const firefox = new FakeVmFirefox();
    const { fill, page } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com" }], () => false);
    expect((await fill()).ok).toBe(false);
    expect(firefox.cuaCalls.some((call) => call.name === "type_text")).toBe(false);
    expect(page.problem()).toMatch(/no longer yours/);
  });

  it("keeps a username already there and types a fresh one-time code", async () => {
    const firefox = new FakeVmFirefox();
    firefox.boxes = { username: "alice@example.com", password: "", code0: "" };
    const { fill, remembered } = setup(firefox, [{ host: "accounts.example.com", username: "alice@example.com", totp: true }]);
    const outcome = await fill();
    expect(outcome.filled).toEqual(["username", "password", "code"]);
    expect(firefox.boxes.code0).toBe(totpCode(KEY, NOW));
    expect(firefox.cuaCalls.filter((call) => call.name === "type_text").map((call) => call.args.text)).toEqual([PASSWORD, totpCode(KEY, NOW)]);
    expect(remembered).toContainEqual(["code", totpCode(KEY, NOW)]);
  });

  it("explains a missing Firefox or an old desktop in words the bot can act on", async () => {
    for (const [error, words] of [["no_firefox", /Firefox is not open/], ["no_atspi", /recreate the Local VM/], ["ambiguous_window", /Several Firefox windows/]] as const) {
      const page = vmLoginPage({ probe: async () => ({ error }), input: async () => { throw new Error("unused"); }, stillAllowed: () => true });
      const outcome = await fillLoginOn({ candidates: async () => [], available: async () => [] }, page, { remember: () => undefined });
      expect(outcome.ok).toBe(false);
      expect(page.problem()).toMatch(words);
    }
  });
});

describe("the in-VM accessibility probe", () => {
  it("is plain system Python that reads the top document's DocURL and never types", () => {
    expect(firefoxProbeArgs("openmausbot-computer-abc")).toEqual(expect.arrayContaining(["exec", "-i", "-u", "cua", "openmausbot-computer-abc", "/usr/bin/python3", "-c", FIREFOX_A11Y_SCRIPT]));
    expect(FIREFOX_A11Y_SCRIPT).toContain('"DocURL"');
    expect(FIREFOX_A11Y_SCRIPT).toContain('if r == "document web" and node is not doc: return');
    expect(FIREFOX_A11Y_SCRIPT).not.toMatch(/generate_keyboard_event|set_text_contents|insert_text/);
  });
});
