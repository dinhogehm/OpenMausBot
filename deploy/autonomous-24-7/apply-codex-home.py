#!/usr/bin/env python3
"""CODEX_HOME isolado para os bots do OpenMausBot (~/.codex-omb).

Deriva ~/.codex-omb/config.toml do ~/.codex/config.toml pessoal removendo o
que só faz sentido no Codex interativo e que derruba turnos autônomos:
mcp_servers.*, plugins.*, marketplaces.*, notify, hooks. Copia auth.json
(cópia, não symlink — o Codex regrava o refresh token). Aponta
instances.codex.environment.CODEX_HOME em ~/.openmausbot/config.json.

Idempotente. DRY_RUN=1 mostra sem gravar. Rode com o OpenMausBot FECHADO.
"""
import json, os, re, shutil, stat, sys, time

SRC = os.path.expanduser("~/.codex")
DST = os.path.expanduser("~/.codex-omb")
OMB = os.path.expanduser("~/.openmausbot/config.json")
DRY = os.environ.get("DRY_RUN") == "1"
DROP_PREFIXES = ("mcp_servers", "plugins", "marketplaces", "hooks", "notify")
DROP_TOPLEVEL = ("notify",)


def derive(text: str) -> str:
    out, keep = [], True
    for line in text.splitlines():
        m = re.match(r"^\s*\[\[?\s*([^\]\s.]+)", line)
        if m:
            keep = not m.group(1).strip('"').startswith(DROP_PREFIXES)
        elif keep and re.match(r"^\s*(%s)\s*=" % "|".join(DROP_TOPLEVEL), line):
            continue
        if keep:
            out.append(line)
    body = "\n".join(out).rstrip() + "\n"
    header = ("# Gerado por apply-codex-home.py a partir de ~/.codex/config.toml.\n"
              "# CODEX_HOME dos bots do OpenMausBot: sem mcp_servers, plugins, marketplaces, notify e hooks.\n"
              "# Reaplique o script depois de mudar o config pessoal.\n")
    return header + body


def main():
    src_cfg = open(os.path.join(SRC, "config.toml")).read()
    derived = derive(src_cfg)
    for bad in DROP_PREFIXES:
        assert not re.search(r"^\s*\[%s" % bad, derived, re.M), bad
    assert "SkyComputerUseClient" not in derived
    plan = []
    cur = os.path.join(DST, "config.toml")
    if not os.path.isfile(cur) or open(cur).read() != derived:
        plan.append("config.toml")
    for name in ("auth.json", "AGENTS.md"):
        s, d = os.path.join(SRC, name), os.path.join(DST, name)
        if os.path.isfile(s) and (not os.path.isfile(d) or open(s, "rb").read() != open(d, "rb").read()):
            plan.append(name)
    omb = json.load(open(OMB))
    env = omb.setdefault("instances", {}).setdefault("codex", {}).setdefault("environment", {})
    omb_changed = env.get("CODEX_HOME") != DST
    print("mudanças:", plan or "nenhuma", "| config.json:", "CODEX_HOME" if omb_changed else "ok")
    kept = [l for l in derived.splitlines() if l.startswith("[")]
    print("seções mantidas:", ", ".join(kept[:6]), "..." if len(kept) > 6 else "")
    if DRY:
        print("DRY_RUN=1 — nada gravado"); return
    os.makedirs(DST, mode=0o700, exist_ok=True)
    os.chmod(DST, 0o700)
    if "config.toml" in plan:
        if os.path.isfile(cur):
            shutil.copy2(cur, cur + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
        with open(cur, "w") as f:
            f.write(derived)
        os.chmod(cur, 0o600)
    for name in ("auth.json", "AGENTS.md"):
        if name in plan:
            shutil.copy2(os.path.join(SRC, name), os.path.join(DST, name))
            os.chmod(os.path.join(DST, name), 0o600)
    if omb_changed:
        shutil.copy2(OMB, OMB + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
        env["CODEX_HOME"] = DST
        tmp = OMB + ".tmp"
        with open(tmp, "w") as f:
            json.dump(omb, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, OMB)
    print("aplicado em", DST)


if __name__ == "__main__":
    main()
