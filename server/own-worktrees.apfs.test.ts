import { execFile, execFileSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cloneSeedCaches, lockHash, physicalOffset, realCloneIo, type Exec, type SeedState } from "./own-worktrees.ts";

// The clone for real, in a temporary folder: on APFS, the cloned file shares
// the original's blocks (the same physical offset on the device, read with
// fcntl F_LOG2PHYS), a plain copy does not, and writing to the clone leaves
// the original as it was (copy-on-write). Nothing of the user's is touched.

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const exec: Exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout))));
});

/** On this Mac's temporary folder, cp -c clones and perl can read where blocks are. */
function canProve(): boolean {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/perl")) return false;
  const dir = mkdtempSync(join(tmpdir(), "omb-apfs-probe-"));
  try {
    writeFileSync(join(dir, "a"), "x".repeat(300_000));
    execFileSync("/bin/cp", ["-c", join(dir, "a"), join(dir, "b")]);
    const read = (path: string) => execFileSync("/usr/bin/perl", ["-e", 'open(my $f, "<", $ARGV[0]) or die; my $b = pack("Lqq", 0, 0, 0); fcntl($f, 49, $b) or die; print unpack("H*", substr($b, 12, 8));', path]).toString();
    return read(join(dir, "a")) === read(join(dir, "b"));
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const APFS = canProve();

it.runIf(APFS)("clones node_modules without duplicating its blocks: same physical offset as the seed's, copy-on-write on change, links kept relative", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-apfs-"));
  temps.push(root);
  const seedPath = join(root, "repo", ".claude", "omb-seed");
  const worktree = join(root, "repo", ".claude", "worktrees", "9353-x");
  const lock = `{"lockfileVersion":3,"packages":{"":{"name":"x"}},"pad":"${"p".repeat(200_000)}"}`;
  for (const dir of [join(seedPath, "node_modules", "big"), join(seedPath, "node_modules", ".bin"), join(seedPath, "web", "node_modules", "w"), join(worktree, "web")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(seedPath, "package-lock.json"), lock);
  writeFileSync(join(worktree, "package-lock.json"), lock);
  // 8 MiB of noise: big enough to own its blocks
  const big = Buffer.alloc(8 * 1024 * 1024);
  randomFillSync(big);
  writeFileSync(join(seedPath, "node_modules", "big", "index.bin"), big);
  writeFileSync(join(seedPath, "web", "node_modules", "w", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(seedPath, "node_modules", ".bin", "real"), "#!/bin/sh\n");
  execFileSync("/bin/ln", ["-s", "../big/index.bin", join(seedPath, "node_modules", ".bin", "big")]);
  const seed: SeedState = { repo: join(root, "repo"), path: seedPath, state: "ready", lockName: "package-lock.json", lockHash: lockHash(lock), node: "v1", installMs: 600_000, dirs: [{ path: "node_modules", kb: 8_200 }, { path: "web/node_modules", kb: 4 }] };

  // the production path: cp -c probe proved by its blocks, then cp -c -R per folder
  const out = await cloneSeedCaches(seed, worktree, ["package-lock.json"], realCloneIo(exec, async () => "v1"));
  expect(out).toMatchObject({ mode: "cloned", dirs: ["node_modules", "web/node_modules"], savedKb: 8_204, savedMs: 600_000 });

  const original = join(seedPath, "node_modules", "big", "index.bin");
  const clone = join(worktree, "node_modules", "big", "index.bin");
  // the same blocks on the device: nothing was copied
  const at = await physicalOffset(original, exec);
  expect(at).toMatch(/^[0-9a-f]{16}$/);
  expect(await physicalOffset(clone, exec)).toBe(at);
  // control: a plain copy gets blocks of its own
  const plain = join(root, "plain.bin");
  copyFileSync(original, plain);
  expect(await physicalOffset(plain, exec)).not.toBe(at);
  // copy-on-write: changing the clone leaves the seed as it was
  writeFileSync(clone, Buffer.from("changed"));
  expect(readFileSync(original).equals(big)).toBe(true);
  // a link stays a relative link, resolving inside the worktree
  const link = join(worktree, "node_modules", ".bin", "big");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe("../big/index.bin");
  expect(readFileSync(join(worktree, "web", "node_modules", "w", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  // no temporary copy and no probe left behind
  expect(existsSync(join(worktree, "node_modules.omb-clone"))).toBe(false);
  expect(existsSync(join(worktree, ".omb-clone-probe"))).toBe(false);
});

it.runIf(process.platform === "darwin")("refuses before copying anything when the probe shows a plain copy, instead of letting cp -c copy it all", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-apfs-"));
  temps.push(root);
  const seedPath = join(root, "seed");
  const worktree = join(root, "wt");
  mkdirSync(join(seedPath, "node_modules"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(seedPath, "package-lock.json"), "{}");
  writeFileSync(join(worktree, "package-lock.json"), "{}");
  const calls: string[][] = [];
  const io = { ...realCloneIo(async (file, args) => { calls.push([file, ...args]); return ""; }, async () => "v1"), cloneFile: async () => "cp -c fez uma cópia comum, não um clone" };
  const out = await cloneSeedCaches({ repo: root, path: seedPath, state: "ready", lockName: "package-lock.json", lockHash: lockHash("{}"), node: "v1", dirs: [{ path: "node_modules", kb: 1 }] }, worktree, ["package-lock.json"], io);
  expect(out).toMatchObject({ mode: "install", reason: "o volume não clona arquivos (não é APFS?): cp -c fez uma cópia comum, não um clone" });
  expect(calls).toEqual([]);
  expect(existsSync(join(worktree, "node_modules"))).toBe(false);
});

it.runIf(APFS)("the probe itself tells a clone from a copy by the blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-apfs-"));
  temps.push(root);
  writeFileSync(join(root, "a"), "y".repeat(300_000));
  const io = realCloneIo(exec, async () => "v1");
  expect(await io.cloneFile(join(root, "a"), join(root, "b"))).toBeNull();
  // a copier that never clones (what cp -c does on another volume): caught
  const copier = realCloneIo(async (file, args, options) => (file === "/bin/cp" ? exec(file, args.filter((arg) => arg !== "-c"), options) : exec(file, args, options)), async () => "v1");
  expect(await copier.cloneFile(join(root, "a"), join(root, "c"))).toBe("cp -c fez uma cópia comum, não um clone");
});
