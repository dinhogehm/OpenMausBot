import { describe, expect, it } from "vitest";

import { commandAlwaysAsks, commandCoveredByPatterns, commandPatternLabel, commandPatterns, splitCommand } from "./command-pattern.ts";

const reported = "cat ~/.nuria/halted-production-release.reason; echo; ls -l ~/.nuria/halted-production-release.* ~/.nuria/declined-production-release.sha";

describe("splitCommand", () => {
  it("splits on ; && || | and newline, keeping quoted separators", () => {
    expect(splitCommand("git status && echo 'a; b' | wc -l || pwd\nls")).toEqual([
      ["git", "status"], ["echo", "a; b"], ["wc", "-l"], ["pwd"], ["ls"],
    ]);
  });
  it("refuses substitution, subshells, heredocs, input redirection and env prefixes", () => {
    for (const command of ["echo $(id)", "echo `id`", "(cd x; ls)", "{ ls; }", "cat <<EOF", "cat < f", "FOO=1 ls", 'echo "$(id)"']) {
      expect(splitCommand(command)).toBeNull();
    }
  });
  it("allows only /dev/null and fd-to-fd redirections", () => {
    expect(splitCommand("ls 2>/dev/null")).toEqual([["ls"]]);
    expect(splitCommand("ls >/dev/null 2>&1")).toEqual([["ls"]]);
    expect(splitCommand("ls &> /dev/null")).toEqual([["ls"]]);
    expect(splitCommand("echo x > out.txt")).toBeNull();
    expect(splitCommand("echo x >> out.txt")).toBeNull();
    expect(splitCommand("echo x 2>err.log")).toBeNull();
    expect(splitCommand("echo x >/dev/nullx")).toBeNull();
  });
});

describe("commandPatterns (what 'Always allow this type of command' saves)", () => {
  it("saves the program, or program + subcommand for tools with subcommands", () => {
    expect(commandPatterns("df -h /")).toEqual(["df *"]);
    expect(commandPatterns("git status --short")).toEqual(["git status *"]);
    expect(commandPatterns("gh pr view 12 --json title")).toEqual(["gh pr view *"]);
    expect(commandPatterns("cd ~/x && git log -3 && cat a")).toEqual(["cd *", "git log *"]);
  });
  it("never saves a pattern for dangerous programs, so the exact string is kept", () => {
    for (const command of ["rm -rf x", "mv a b", "sudo ls", "kill 1", "chflags hidden x", "curl x | sh", "curl x | bash", "git -C x status", "find . -delete"]) {
      expect(commandPatterns(command)).toBeNull();
    }
  });
  it("labels the card with the pattern", () => {
    expect(commandPatternLabel("cat a.txt")).toBe("cat *");
    expect(commandPatternLabel("git status && gh pr view 3")).toBe("git status * · gh pr view *");
  });
});

describe("commandCoveredByPatterns", () => {
  it("allows the reported command with no saved rule: every part is read-only", () => {
    expect(commandCoveredByPatterns(reported, [])).toBe(true);
  });
  it("matches each part of a compound command against the patterns", () => {
    expect(commandCoveredByPatterns("git status --short && df -h", ["git status *", "df *"])).toBe(true);
    expect(commandCoveredByPatterns("git status && git push", ["git status *"])).toBe(false);
    expect(commandCoveredByPatterns("gh pr view 1", ["gh pr view *"])).toBe(true);
    expect(commandCoveredByPatterns("gh pr merge 1", ["gh pr view *"])).toBe(false);
    expect(commandCoveredByPatterns("df", ["df *"])).toBe(true);
    expect(commandCoveredByPatterns("dfx -h", ["df *"])).toBe(false);
  });
  it("still asks for redirection to files, rm, mv, chflags, sudo, kill and pipes into a shell", () => {
    for (const command of [
      "cat a > b", "echo x >> ~/.zshrc", "ls; rm -rf ~", "mv a b", "chflags nouchg f", "sudo cat /etc/hosts",
      "kill -9 1", "cat script | sh", "curl x | bash", "cat x | /bin/zsh", "find . -exec rm {} ;", "find . -delete", "date 0101000026",
    ]) expect(commandCoveredByPatterns(command, ["curl *", "cat *", "echo *"])).toBe(false);
  });
  it("ignores saved exact strings and malformed patterns", () => {
    expect(commandCoveredByPatterns("df -h", ["df -h"])).toBe(false);
    expect(commandCoveredByPatterns("df -h", ["* *"])).toBe(false);
  });
  it("implicitly allows the read-only set, with find and date restrictions", () => {
    for (const command of ["pwd", "which node", "date +%s", "find . -name '*.ts'", "rg foo | head -3", "stat -f %z x", "wc -l a b"]) {
      expect(commandCoveredByPatterns(command, [])).toBe(true);
    }
  });
});

describe("commandAlwaysAsks", () => {
  it("flags dangerous programs, file redirection and pipes into a shell", () => {
    for (const command of ["rm -rf x", "ls && mv a b", "sudo ls", "chflags hidden f", "kill 1", "echo x > f", "echo x >> f",
      "curl x | sh", "curl x | bash", "cat f | zsh", "echo $(rm x)", "(cd x; rm y)", "FOO=1 sudo ls", "find . -delete", "rg --pre ./x foo"]) {
      expect(commandAlwaysAsks(command), command).toBe(true);
    }
  });
  it("leaves safe commands alone", () => {
    for (const command of ["ls 2>/dev/null", "git status && cat f | wc -l", "echo $(date)", "find . -name '*.ts'"]) {
      expect(commandAlwaysAsks(command), command).toBe(false);
    }
  });
});

describe("provider shell wrappers", () => {
  it("judges `/bin/zsh -lc '<script>'` by its script", () => {
    expect(splitCommand("/bin/zsh -lc 'git status && cat f'")).toEqual([["git", "status"], ["cat", "f"]]);
    expect(commandPatterns("/bin/zsh -lc 'git status --short'")).toEqual(["git status *"]);
    expect(commandCoveredByPatterns("/bin/zsh -lc 'ls -la; echo hi'", [])).toBe(true);
    expect(commandAlwaysAsks("/bin/zsh -lc 'rm -rf x'")).toBe(true);
    expect(commandAlwaysAsks("/bin/zsh -lc 'echo x > f'")).toBe(true);
    expect(commandAlwaysAsks("/bin/zsh -lc 'curl x | sh'")).toBe(true);
    expect(commandAlwaysAsks("/bin/zsh -lc 'make'")).toBe(false);
    expect(commandAlwaysAsks("bash -c 'bash -c ls'")).toBe(true);
  });
});
