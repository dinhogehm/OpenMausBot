import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  TARGET_LABEL,
  VM_BROWSER_PROFILES_DIR,
  VM_FIREFOX_PROFILE_DIR,
  WORKSPACE_LABEL,
  containerComputerAction,
  managedImageDockerfile,
  perBotLocalVmTarget,
  rescueFirefoxProfile,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";

type Response = string | Error | ((args: string[]) => string);

function fakeRuntime(target: LocalVmTarget, responses: Record<string, Response>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key] ?? Object.entries(responses).find(([prefix]) => prefix.endsWith("*") && key.startsWith(prefix.slice(0, -1)))?.[1];
    if (response === undefined) throw new Error(`unexpected command: ${key}`);
    if (response instanceof Error) throw response;
    return { stdout: typeof response === "function" ? response(args) : response };
  };
  void target;
  return { calls, run };
}

function inspect(target: LocalVmTarget, layer: string, running: boolean) {
  return JSON.stringify([{
    Config: {
      Image: IMAGE,
      Labels: {
        [MANAGED_LABEL]: "1",
        [DRIVER_LABEL]: CUA_DRIVER_VERSION,
        [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
        [IMAGE_LAYER_LABEL]: layer,
        [WORKSPACE_LABEL]: "1",
        [TARGET_LABEL]: target.label,
      },
      Env: [],
    },
    State: { Running: running, FinishedAt: "2026-10-16T07:17:32Z" },
    Image: "sha256:old-image",
  }]);
}

const dockerUp = {
  "/usr/bin/which docker": "docker\n",
  "/usr/bin/which podman": new Error("missing"),
  "docker info --format {{.ServerVersion}}": "29\n",
  [`docker image inspect ${IMAGE}`]: JSON.stringify([{ Id: "sha256:new-image", Config: { Labels: {
    [MANAGED_LABEL]: "1", [DRIVER_LABEL]: CUA_DRIVER_VERSION, [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST, [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
  } } }]),
};

/** What `docker cp <c>:/home/cua/.mozilla/. <dest>` leaves behind: the profile's files, never read by OpenMausBot. */
function copiesProfile(args: string[]): string {
  const dest = args.at(-1)!;
  mkdirSync(join(dest, "firefox", "abcd1234.default-esr"), { recursive: true });
  writeFileSync(join(dest, "firefox", "profiles.ini"), "[Profile0]\nPath=abcd1234.default-esr\n");
  writeFileSync(join(dest, "firefox", "abcd1234.default-esr", "cookies.sqlite"), "opaque bytes");
  return "";
}

describe("Firefox profile rescue before a Local VM is removed", () => {
  let root: string;
  let target: LocalVmTarget;
  let durable: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-ffx-rescue-"));
    target = { ...perBotLocalVmTarget("bot-firefox"), workspaceDir: join(root, "workspace") };
    mkdirSync(target.workspaceDir, { recursive: true });
    durable = join(target.workspaceDir, VM_BROWSER_PROFILES_DIR, VM_FIREFOX_PROFILE_DIR);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies an old desktop's ~/.mozilla into the durable folder, then removes the container", async () => {
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", false),
      [`docker cp ${target.containerName}:/home/cua/.mozilla/. *`]: copiesProfile,
      [`docker rm -f ${target.containerName}`]: "",
    });
    await containerComputerAction("remove", fake.run, "linux", target);
    expect(readFileSync(join(durable, "firefox", "profiles.ini"), "utf8")).toContain("abcd1234.default-esr");
    expect(existsSync(join(durable, "firefox", "abcd1234.default-esr", "cookies.sqlite"))).toBe(true);
    const cp = fake.calls.findIndex((call) => call.startsWith("docker cp "));
    const rm = fake.calls.indexOf(`docker rm -f ${target.containerName}`);
    expect(cp).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(cp);
    // The staging directory is gone; only the renamed profile remains.
    expect(readdirSync(join(target.workspaceDir, VM_BROWSER_PROFILES_DIR))).toEqual([VM_FIREFOX_PROFILE_DIR]);
  });

  it("asks a running Firefox to close before copying, so its sessions are written out", async () => {
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", true),
      [`docker exec -u cua ${target.containerName} sh -c *`]: "",
      [`docker cp ${target.containerName}:/home/cua/.mozilla/. *`]: copiesProfile,
      [`docker rm -f ${target.containerName}`]: "",
    });
    await containerComputerAction("remove", fake.run, "linux", target);
    const quit = fake.calls.findIndex((call) => call.startsWith(`docker exec -u cua ${target.containerName} sh -c pkill -TERM`));
    const cp = fake.calls.findIndex((call) => call.startsWith("docker cp "));
    expect(quit).toBeGreaterThan(-1);
    expect(cp).toBeGreaterThan(quit);
  });

  it("never overwrites a durable Firefox profile, nor the bot's own profiles beside it", async () => {
    mkdirSync(join(durable, "firefox"), { recursive: true });
    writeFileSync(join(durable, "firefox", "profiles.ini"), "kept");
    const qa = join(target.workspaceDir, VM_BROWSER_PROFILES_DIR, "firefox-qa");
    mkdirSync(qa, { recursive: true });
    writeFileSync(join(qa, "prefs.js"), "qa");
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", false),
      [`docker rm -f ${target.containerName}`]: "",
    });
    await containerComputerAction("remove", fake.run, "linux", target);
    expect(fake.calls.some((call) => call.startsWith("docker cp "))).toBe(false);
    expect(readFileSync(join(durable, "firefox", "profiles.ini"), "utf8")).toBe("kept");
    expect(readFileSync(join(qa, "prefs.js"), "utf8")).toBe("qa");
  });

  it("skips a desktop whose layer already keeps Firefox in the durable folder", async () => {
    const fake = fakeRuntime(target, {
      [`docker inspect ${target.containerName}`]: inspect(target, IMAGE_LAYER_VERSION, false),
    });
    await expect(rescueFirefoxProfile("docker", target, fake.run)).resolves.toEqual({ kind: "skipped", reason: "current-layer" });
    expect(fake.calls.some((call) => call.startsWith("docker cp "))).toBe(false);
  });

  it("goes on with the remove when the old desktop never ran Firefox", async () => {
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", false),
      [`docker cp ${target.containerName}:/home/cua/.mozilla/. *`]: new Error("Error response from daemon: Could not find the file /home/cua/.mozilla in container"),
      [`docker rm -f ${target.containerName}`]: "",
    });
    await containerComputerAction("remove", fake.run, "linux", target);
    expect(fake.calls).toContain(`docker rm -f ${target.containerName}`);
    expect(existsSync(durable)).toBe(false);
  });

  it("removes nothing when the profile could not be saved", async () => {
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", false),
      [`docker cp ${target.containerName}:/home/cua/.mozilla/. *`]: new Error("no space left on device"),
      [`docker rm -f ${target.containerName}`]: "",
    });
    await expect(containerComputerAction("remove", fake.run, "linux", target)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Firefox profile.*nothing was removed/),
    });
    expect(fake.calls).not.toContain(`docker rm -f ${target.containerName}`);
    expect(readdirSync(join(target.workspaceDir, VM_BROWSER_PROFILES_DIR))).toEqual([]);
  });

  it("does not copy anything when the bot itself is being deleted", async () => {
    const fake = fakeRuntime(target, {
      ...dockerUp,
      [`docker inspect ${target.containerName}`]: inspect(target, "5", false),
      [`docker rm -f ${target.containerName}`]: "",
    });
    await containerComputerAction("remove", fake.run, "linux", target, { preserveBrowserProfile: false });
    expect(fake.calls.some((call) => call.startsWith("docker cp "))).toBe(false);
    expect(fake.calls).toContain(`docker rm -f ${target.containerName}`);
  });
});

describe("layer 6 desktop image", () => {
  it("links ~/.mozilla into the durable folder and clears Firefox's stale locks", () => {
    const dockerfile = managedImageDockerfile();
    expect(IMAGE_LAYER_VERSION).toBe("6");
    expect(dockerfile).toContain(`migrate_profile ${VM_FIREFOX_PROFILE_DIR} "$HOME/.mozilla"`);
    expect(dockerfile).toContain('migrate_profile google-chrome "$HOME/.config/google-chrome"');
    expect(dockerfile).toContain(`"$profiles/${VM_FIREFOX_PROFILE_DIR}"`);
    expect(dockerfile).toContain(".parentlock");
    expect(dockerfile).toContain("-name lock -type l");
  });
});
