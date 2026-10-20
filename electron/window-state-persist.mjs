// The main window's size and place, saved as the person leaves them and read back at launch.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseWindowState } = require("./window-state.cjs");

export function createWindowStatePersistence({ userDataDir, slog }) {
  function windowStateFile() {
    return path.join(userDataDir(), "window-state.json");
  }

  function readWindowState() {
    try {
      return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
    } catch {
      return null;
    }
  }

  function writeWindowState(win) {
    if (!win || win.isDestroyed()) return;
    const file = windowStateFile();
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        temporary,
        JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, file);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {}
      slog(`window state save failed: ${error?.message ?? error}`);
    }
  }

  function installWindowStatePersistence(win) {
    let timer = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      writeWindowState(win);
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 250);
      timer.unref?.();
    };
    win.on("resize", schedule);
    win.on("move", schedule);
    const pushMaximized = () => {
      try {
        if (!win.isDestroyed()) win.webContents.send("window:maximized-changed", win.isMaximized());
      } catch {}
    };
    win.on("maximize", pushMaximized);
    win.on("unmaximize", pushMaximized);
    win.on("maximize", schedule);
    win.on("unmaximize", schedule);
    win.on("close", flush);
  }

  return { readWindowState, installWindowStatePersistence };
}
