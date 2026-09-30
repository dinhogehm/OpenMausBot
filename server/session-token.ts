// The GitHub token Claude Code sessions run with. The owner keeps a token
// WITHOUT admin rights in the macOS Keychain (service
// "nuria-sessions-gh-token", account = the user); sessions for the
// repositories it is meant for get it as GH_TOKEN/GITHUB_TOKEN, so they act
// with less than the owner's own gh. The value lives only in this process's
// memory: never logged, never written to disk or to a session record.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

export const SESSION_TOKEN_SERVICE = "nuria-sessions-gh-token";
/** Repositories whose sessions get the token (their folder name). */
export const SESSION_TOKEN_REPOS = /(^|\/)nuria-platform\/?$/;
const CACHE_MS = 5 * 60_000;

type Reader = (file: string, args: string[]) => string;

const keychain: Reader = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });

export class SessionToken {
  private cached: { value: string | null; at: number } | null = null;
  private readonly read: Reader;
  private readonly user: string;
  private readonly now: () => number;

  // plain field assignments, not parameter properties (node type-stripping)
  constructor(opts: { read?: Reader; user?: string; now?: () => number } = {}) {
    this.read = opts.read ?? keychain;
    this.user = opts.user ?? userInfo().username;
    this.now = opts.now ?? Date.now;
  }

  /** The token, or null when there is none (or not on a Mac). Cached briefly. */
  value(): string | null {
    if (process.platform !== "darwin" && this.read === keychain) return null;
    const at = this.now();
    if (this.cached && at - this.cached.at < CACHE_MS) return this.cached.value;
    let value: string | null = null;
    try {
      value = this.read("/usr/bin/security", ["find-generic-password", "-s", SESSION_TOKEN_SERVICE, "-a", this.user, "-w"]).trim() || null;
    } catch {
      value = null; // not in the Keychain: sessions use the owner's gh as before
    }
    this.cached = { value, at };
    return value;
  }

  /** The env additions for a session in `repo`: the token for its repositories,
   * `missing` when it should have one and there is none. */
  envFor(repo: string): { env: Record<string, string>; missing: boolean } {
    if (!SESSION_TOKEN_REPOS.test(repo)) return { env: {}, missing: false };
    const token = this.value();
    return token ? { env: { GH_TOKEN: token, GITHUB_TOKEN: token }, missing: false } : { env: {}, missing: true };
  }
}
