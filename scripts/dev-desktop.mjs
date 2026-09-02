#!/usr/bin/env node
// One command for the development desktop: start the harness server and the
// Vite renderer, wait until both answer, then open the Electron shell against
// them, and stop everything when the window closes. Before this, `dev:desktop`
// opened a window that expected two other terminals to already be running.
//
// The readiness check for the server is /api/health, which echoes the pid of
// the process answering. A port that answers with a different pid belongs to
// another OpenMausBot (typically the installed app) — that must be reported,
// never silently used, because two servers on one data directory corrupt it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDevConfig(env = process.env) {
  const serverPort = Number(env.OMB_PORT || env.OGB_PORT || 8799);
  const uiPort = Number(env.OMB_DEV_UI_PORT || 5199);
  return {
    serverPort,
    uiPort,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    // 127.0.0.1 on purpose: Vite binds IPv4, and a bare "localhost" can
    // resolve to ::1 inside Electron and paint a black window.
    uiUrl: `http://127.0.0.1:${uiPort}`,
    bootTimeoutMs: Number(env.OMB_DEV_BOOT_TIMEOUT_MS || 60_000),
  };
}

/**
 * Poll `url` until it answers 2xx. With `ownerPid`, the JSON body's `pid`
 * must match — anything else is a foreign owner and the poll stops at once
 * rather than waiting out the timeout on a port we will never get.
 * `isAlive` lets the caller abort when the child it is waiting for has died.
 */
export async function waitForHttp(
  url,
  { timeoutMs = 60_000, intervalMs = 500, ownerPid, isAlive = () => true, fetchImpl = fetch } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        if (ownerPid === undefined) return { ok: true };
        const body = await res.json().catch(() => null);
        if (body && body.pid === ownerPid) return { ok: true };
        return { ok: false, reason: "foreign-owner", pid: body?.pid };
      }
    } catch {
      // not listening yet — keep polling
    }
    if (!isAlive()) return { ok: false, reason: "exited" };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, reason: "timeout" };
}

function runToExit(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`))));
  });
}

async function main() {
  const cfg = resolveDevConfig();
  const env = { ...process.env, OMB_PORT: String(cfg.serverPort) };

  // The same connector staging the old dev:desktop did, kept first so a
  // failed download is reported before any port is taken.
  await runToExit(process.execPath, [path.join(ROOT, "scripts", "prepare-cloudflared.mjs"), "--current"], { cwd: ROOT });

  const server = spawn(process.execPath, ["--experimental-strip-types", path.join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
  const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const vite = spawn(process.execPath, [viteBin, "--port", String(cfg.uiPort), "--strictPort"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });

  const children = [server, vite];
  const stopAll = () => {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
  };
  process.on("exit", stopAll);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopAll();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }

  const [serverReady, uiReady] = await Promise.all([
    waitForHttp(`${cfg.serverUrl}/api/health`, {
      timeoutMs: cfg.bootTimeoutMs,
      ownerPid: server.pid,
      isAlive: () => server.exitCode === null,
    }),
    waitForHttp(cfg.uiUrl, { timeoutMs: cfg.bootTimeoutMs, isAlive: () => vite.exitCode === null }),
  ]);

  if (!serverReady.ok) {
    if (serverReady.reason === "foreign-owner") {
      console.error(
        `dev:desktop: port ${cfg.serverPort} already answers as OpenMausBot (pid ${serverReady.pid}) — ` +
          `probably the installed app. Quit it, or run with OMB_PORT=<other port>.`,
      );
    } else {
      console.error(`dev:desktop: the harness server did not come up (${serverReady.reason}).`);
    }
    stopAll();
    process.exit(1);
  }
  if (!uiReady.ok) {
    console.error(`dev:desktop: Vite did not come up on ${cfg.uiUrl} (${uiReady.reason}).`);
    stopAll();
    process.exit(1);
  }

  const electron = spawn(require("electron"), ["."], {
    cwd: ROOT,
    env: { ...env, ELECTRON_START_URL: cfg.uiUrl },
    stdio: "inherit",
  });
  children.push(electron);
  electron.on("exit", (code) => {
    stopAll();
    process.exit(code ?? 0);
  });
  // A window pointed at a dead server or renderer is a blank screen with no
  // explanation; close it and say why instead.
  for (const [name, child] of [
    ["harness server", server],
    ["Vite", vite],
  ]) {
    child.on("exit", (code) => {
      if (electron.exitCode === null && !electron.killed) {
        console.error(`dev:desktop: the ${name} exited (${code}); closing the window.`);
        electron.kill();
      }
    });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`dev:desktop: ${error?.message ?? error}`);
    process.exit(1);
  });
}
