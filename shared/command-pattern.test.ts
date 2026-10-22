import { describe, expect, it } from "vitest";

import { commandCoveredByPatterns, commandPatternLabel, commandPatterns, commandSaveable, splitCommand } from "./command-pattern.ts";

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
    expect(commandPatterns("cd ~/x && git log -3 && cat a")).toEqual(["cd *", "git log *", "cat *"]);
  });
  it("never saves a pattern for dangerous programs: no button, nothing saved", () => {
    for (const command of ["rm -rf x", "mv a b", "sudo ls", "kill 1", "chflags hidden x", "curl x | sh", "curl x | bash", "git -C x status", "find . -delete"]) {
      expect(commandPatterns(command)).toBeNull();
    }
  });
  it("saves every part of the reported pipe, read-only ones included (09:41, Chief of Staff)", () => {
    const cmd = "gh pr view 9700 --json state | ps aux | grep carrier";
    expect(commandPatterns(cmd)).toEqual(["gh pr view *", "ps *", "grep *"]);
    expect(commandPatternLabel(cmd)).toBe("gh pr view * · ps * · grep *");
    expect(commandSaveable(cmd)).toBe(true);
    // what was saved covers the command on Ask, where read-only programs need a rule too
    expect(commandCoveredByPatterns(cmd, commandPatterns(cmd)!, { implicitReadOnly: false })).toBe(true);
  });
  it("offers no button when any part writes or deletes", () => {
    for (const command of ["gh pr view 1 && gh pr merge 1", "git status && git push", "ls | xargs rm", "npm install", "git commit -m x", "gh pr comment 1 --body x", "ps aux; kill 1"]) {
      expect(commandSaveable(command), command).toBe(false);
      expect(commandPatternLabel(command), command).toBeNull();
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

  it("does not imply the read-only set when asked not to (Ask mode)", () => {
    expect(commandCoveredByPatterns("cat a | wc -l", [])).toBe(true);
    expect(commandCoveredByPatterns("cat a | wc -l", [], { implicitReadOnly: false })).toBe(false);
    expect(commandCoveredByPatterns("cat a | wc -l", ["cat *", "wc *"], { implicitReadOnly: false })).toBe(true);
  });
});
