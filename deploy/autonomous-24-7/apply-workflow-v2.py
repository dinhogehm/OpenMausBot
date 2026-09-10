#!/usr/bin/env python3
"""Atualiza o workflow "Entrega contínua · nuria-platform" para o corredor
local de release (carrier + LaunchAgent) e rollback por revert-PR.

Idempotente: reaplica o mesmo estado. DRY_RUN=1 mostra sem gravar.
Backup em ~/.openmausbot/workflows.json.bak-<timestamp> antes de gravar.
Rode com o OpenMausBot FECHADO.
"""
import json, os, sys, time, shutil

WF_ID = "eb42a861-2e2a-414e-b2ef-606ec89ce2ad"
PATH = os.path.expanduser("~/.openmausbot/workflows.json")
DRY = os.environ.get("DRY_RUN") == "1"

H = ("O repositório é /Users/osvaldo/Projetos/nuria-platform (dinhogehm/nuria-platform). "
     "Trabalhe sempre a partir dele.\n")
R = ("Regras do repositório que valem para você: nunca faça push direto em `main` (o pre-push bloqueia); "
     "nunca use `--no-verify`, `--force`, `reset --hard` nem `wrangler` (proibido — o hook barra); "
     "leitura de D1 só por `scripts/d1-readonly-query.sh`; nunca rode `release:local`, `smart-deploy.sh` ou `pnpm deploy`.\n")
BOARD = ("O board é o projeto 10 do usuário dinhogehm (https://github.com/users/dinhogehm/projects/10/views/3). "
         "Colunas de Status, com estes nomes exatos: \"Todo\", \"In progress\", \"Done\".\n"
         "Para ler: `gh project item-list 10 --owner dinhogehm --format json --limit 500`.\n"
         "Para mover um item de coluna: descubra os ids com `gh project field-list 10 --owner dinhogehm --format json` "
         "(campo Status e suas opções) e use `gh project item-edit --project-id <id do projeto> --id <id do item> "
         "--field-id <id do campo Status> --single-select-option-id <id da opção>`. Nunca invente ids.\n")

CARRIER = (
    "Garanta que o topo de `main` seja publicável: `git fetch origin --prune` e, na raiz do repo, "
    "`./scripts/release-carrier.sh --check`. Se imprimir `CARRIER_GATE=OK`, nada a fazer. Se imprimir "
    "`CARRIER_GATE=FAIL`, rode `./scripts/release-carrier.sh --execute --label {label}`: ele abre um PR vazio "
    "(carrier) e tenta o merge por API. Se terminar em `merge_refused`, o check `pr-gate` do PR do carrier ainda "
    "não passou — espere com `gh pr checks <número do PR do carrier> --watch` e rode o `--execute` de novo "
    "(no máximo 3 rodadas). Terminou certo quando imprime `CARRIER_READY=OK`.\n")

MERGE_HOW = (
    "Como fazer o merge: confirme `gh pr checks <n>` verde (o `pr-gate` é check obrigatório) e todas as conversas "
    "resolvidas; se o PR estiver em draft, `gh pr ready <n>`; então `gh pr merge <n> --merge --delete-branch` — "
    "SEMPRE merge commit, nunca squash nem rebase (o release exige um merge de dois pais). Se o `pr-gate` ainda "
    "estiver rodando, espere com `gh pr checks <n> --watch`. Confirme com `git fetch origin` e "
    "`gh pr view <n> --json mergeCommit -q .mergeCommit.oid`, e responda \"mergeado\" com esse SHA.\n")

SHELL = ["shell:git", "shell:gh", "shell:cat", "shell:head", "shell:tail", "shell:grep", "shell:rg", "shell:ls",
         "shell:sed", "shell:awk", "shell:wc", "shell:jq", "shell:date", "shell:cd", "shell:test", "shell:echo",
         "shell:printf", "shell:node", "shell:npm", "shell:npx", "shell:release-carrier.sh", "shell:sleep",
         "shell:find", "shell:diff", "shell:python3", "shell:mkdir", "shell:true", "shell:cp", "shell:touch"]
EDIT = ["edit", "apply_patch", "write"]

NODES = {
    "codificacao": dict(
        timeoutMinutes=90, alwaysAllow=SHELL + EDIT,
        instructions=H + R +
        "Implemente a demanda descrita acima (a especificação está no comentário da issue).\n"
        "Trabalhe num `git worktree` próprio criado do `origin/main` ATUALIZADO: "
        "`git fetch origin && git worktree add ../nuria-wt-<issue> -b fix/<issue> origin/main`, "
        "depois `npm ci --prefer-offline` dentro dele (o node_modules da raiz não é compartilhado). "
        "Nunca implemente no checkout principal.\n"
        "Rode os testes dos workspaces que você tocou antes de abrir o Pull Request "
        "(`npm test --workspace=<apps/x|packages/x|web>` dentro do worktree). "
        "Faça push com `git push -u origin fix/<issue>` — o pre-push roda os testes dos workspaces alterados; "
        "se bloquear, corrija. Abra o PR com `gh pr create --base main` (não em draft) referenciando a issue "
        "(`Closes #<issue>`).\n"
        "Na descrição do PR, escreva um parágrafo em linguagem de usuário sobre o que mudou — a documentação "
        "vai partir dele. Não faça merge. Responda \"pr-aberto\" com o número do PR e o que foi feito.\n"
        "Se o histórico desta rodada trouxer pedidos de mudança ou testes reprovados, corrija exatamente aquilo "
        "no mesmo worktree/branch e faça push de novo.",
    ),
    "testes-pre": dict(
        timeoutMinutes=45, alwaysAllow=SHELL,
        instructions=H + R +
        "No worktree do Pull Request aberto no passo anterior (nunca no checkout principal), rode o portão de merge "
        "do projeto: o comando sancionado é `npm run ci:local:quick -- --resume` na raiz do worktree (lint, "
        "typecheck e testes), mais `npm test --workspace=<x>` para cada workspace do diff. NÃO rode "
        "`npm run ci:local` completo nem o build de release — a CI selada roda na publicação e o projeto proíbe "
        "duplicá-la. Se houver testes de ponta a ponta executáveis localmente para a área tocada, rode-os também.\n"
        "Você verifica, não conserta: nunca edite código neste nó.\n"
        "O que decide o veredito é o que ESTA mudança quebrou, não o que já estava quebrado.\n"
        "Para cada falha, atribua a origem antes de julgar:\n"
        "- Se o teste toca arquivos do diff do PR, é falha do PR.\n"
        "- Se não toca, rode esse mesmo teste no merge-base do PR. Se falhar lá também, é dívida preexistente "
        "do repositório, não deste PR.\n"
        "Responda \"falhou\" apenas se houver ao menos uma falha atribuída ao PR. Liste cada uma com o comando "
        "exato para reproduzir — esse texto volta para quem codificou, então precisa ser acionável.\n"
        "Responda \"passou\" quando nenhuma falha for atribuída ao PR, mesmo que a suíte não esteja inteiramente "
        "verde. Nesse caso o resumo deve dizer o que passou e listar separadamente as falhas preexistentes, com a "
        "evidência de que também falham no merge-base. Elas viram observação para o humano, não motivo de reprovação.\n"
        "Se não conseguir decidir a origem de uma falha, trate como falha do PR e explique o que faltou para atribuir.",
    ),
    "revisao": dict(
        timeoutMinutes=45, alwaysAllow=SHELL,
        instructions=H + R +
        "Revise o Pull Request: leia o diff, verifique se resolve a issue, se os testes cobrem a mudança e se o "
        "check `pr-gate` passou.\n"
        "Classifique o risco:\n"
        "- BAIXO (documentação, textos, estilos, testes, refatoração sem mudança de comportamento): faça o merge "
        "você mesmo e responda \"mergeado\".\n"
        "- SENSÍVEL (autenticação, permissões, cobrança/pagamentos, migrações de dados ou schema, infraestrutura/"
        "deploy, qualquer coisa que toque dados de usuário): NÃO faça merge. Responda \"aguardar-humano\" com um "
        "parágrafo explicando o risco — uma pessoa vai decidir com base nele.\n"
        "- PROBLEMAS: deixe os comentários no PR e responda \"mudancas-pedidas\" com o que precisa mudar.\n"
        + MERGE_HOW,
    ),
    "merge": dict(
        timeoutMinutes=20, alwaysAllow=SHELL,
        instructions=H + R +
        "Uma pessoa aprovou o merge desta mudança sensível.\n" + MERGE_HOW,
    ),
    "deploy": dict(
        timeoutMinutes=30, alwaysAllow=SHELL,
        instructions=H + R +
        "A publicação em produção NÃO é feita por você: o LaunchAgent `com.nuria.production-release` deste Mac "
        "observa `origin/main` a cada 2 minutos e roda o corredor selado (`scripts/macos/release-production.sh` → "
        "`npm run release:local -- --environment production`) assim que o topo de `main` for um carrier válido "
        "(merge de dois pais com tree(HEAD) == tree(HEAD^2)). Seu trabalho tem duas partes.\n\n"
        "1. " + CARRIER.format(label="omb-<número da issue>") +
        "Se não convergir, responda \"falhou\" explicando.\n\n"
        "2. Verifique se a publicação aconteceu. Leia `.deploy-history/deploy-receipt-production.env` (campos "
        "`COMMIT`, `DEPLOYED_AT`, `PURGE_RESULT`, `REMOTE_TARGETS`) e o topo com `git rev-parse origin/main`:\n"
        "- Se `git merge-base --is-ancestor <SHA do merge do PR desta rodada> <COMMIT do recibo>` for verdadeiro e "
        "`PURGE_RESULT=success`, produção já contém a mudança: responda \"publicado\" com COMMIT, DEPLOYED_AT e os "
        "workers/pages afetados.\n"
        "- Se o recibo ainda aponta para um commit anterior ao merge, o release está em andamento ou ainda não foi "
        "disparado. Leia o fim de `~/.nuria/logs/production-release.out.log` e `~/.nuria/logs/production-release.err.log`. "
        "Se o log mostra o release rodando (CI, migrations, deploy) ou o agente ainda não pegou este topo, responda "
        "\"aguardando\" com uma linha do que o log diz. Um release leva 30–60 min; este nó volta a rodar a cada 15 min.\n"
        "- Se o log mostra que o release DESTE topo abortou ou falhou (\"Release aborted\", \"Production release "
        "requires\", CI reprovada, exit diferente de 0), ou `~/.nuria/last-seen-main.sha` é igual ao topo (o agente "
        "inspecionou e pulou), responda \"falhou\" com a linha exata do erro. Não tente consertar nada.\n"
        "- Se o histórico desta rodada mostra que você já respondeu \"aguardando\" 6 vezes para este mesmo topo, "
        "responda \"falhou\" com o último estado do log.\n"
        "Responda sempre com uma destas palavras: \"publicado\", \"aguardando\" ou \"falhou\".",
        outcomes=["publicado", "aguardando", "falhou"],
    ),
    "testes-prod": dict(
        timeoutMinutes=30, alwaysAllow=SHELL,
        instructions=H + R +
        "Rode os testes de fumaça contra PRODUÇÃO (*.nuria.run) para a funcionalidade que acabou de subir — "
        "Playwright conforme o projeto (`npm run test:e2e` com a configuração de produção, ou o spec da área "
        "tocada). Não edite código.\n"
        "Isto é confirmação — o portão de qualidade já passou antes do merge. Responda \"passou\" ou \"falhou\" "
        "com o que quebrou (comando, URL e trecho do erro).",
    ),
    "rollback": dict(
        timeoutMinutes=45, alwaysAllow=SHELL + EDIT,
        instructions=H + R +
        "O deploy ou os testes em produção falharam. Não existe rollback automático no corredor: reverter é "
        "publicar um revert por PR pelo mesmo caminho (PR → merge → carrier → LaunchAgent publica).\n\n"
        "Primeiro decida se há o que reverter: leia `.deploy-history/deploy-receipt-production.env`. Se o `COMMIT` "
        "do recibo NÃO contém o merge desta rodada (`git merge-base --is-ancestor <SHA do merge> <COMMIT>` falso), a "
        "mudança nunca chegou a produção — responda \"nada-a-reverter\" com o COMMIT do recibo e o motivo da falha.\n\n"
        "Se chegou, e o histórico desta rodada ainda NÃO tem um PR de revert aberto por você:\n"
        "1. `git fetch origin && git worktree add ../nuria-wt-revert-<issue> -b revert/<issue> origin/main`\n"
        "2. `git -C ../nuria-wt-revert-<issue> revert -m 1 --no-edit <SHA do merge do PR>` (é um merge commit; "
        "`-m 1` mantém main como base). Se houver conflito, `git revert --abort` e responda \"falhou\" com o conflito.\n"
        "3. `git -C ../nuria-wt-revert-<issue> push -u origin revert/<issue>` (o pre-push roda os testes dos "
        "workspaces afetados).\n"
        "4. `gh pr create --base main --head revert/<issue> --title \"Revert: <título do PR original>\" --body "
        "\"<o que falhou em produção, com o trecho do log ou do teste>\"`.\n"
        "5. `gh pr checks <número> --watch`; então `gh pr merge <número> --merge --delete-branch` (nunca squash/rebase).\n"
        "6. " + CARRIER.format(label="revert-<número da issue>") +
        "Depois responda \"aguardando\".\n\n"
        "Se o histórico já tem o PR de revert mergeado: verifique o recibo. Quando `COMMIT` contiver o merge do revert "
        "e `PURGE_RESULT=success`, responda \"revertido\" com COMMIT e DEPLOYED_AT. Se ainda não, leia o fim de "
        "`~/.nuria/logs/production-release.out.log` e `.err.log`: release em andamento → \"aguardando\" (este nó volta "
        "a rodar a cada 15 min); release deste topo abortado/falho, ou \"aguardando\" já respondido 6 vezes → "
        "\"falhou\" com a linha do erro.\n"
        "Responda com uma destas palavras: \"revertido\", \"aguardando\", \"nada-a-reverter\" ou \"falhou\".",
        outcomes=["revertido", "aguardando", "nada-a-reverter", "falhou"],
    ),
    "doc": dict(
        timeoutMinutes=30, alwaysAllow=SHELL + EDIT,
        instructions=H + R +
        "Documente a mudança que entrou. Parta da descrição do Pull Request e das mensagens de commit — não releia "
        "o diff inteiro. Atualize o changelog e, se a mudança for visível ao usuário, escreva um texto curto "
        "explicando o que mudou e por quê. Se isso exigir commit, faça num worktree próprio a partir de "
        "`origin/main`, abra PR para `main` (`docs: ...`) e faça merge com `gh pr merge --merge` depois do "
        "`pr-gate`; nunca push direto em main. Responda \"publicado\" com o que escreveu e o link.",
    ),
    "update-canal": dict(
        timeoutMinutes=20, alwaysAllow=SHELL,
        instructions=H + BOARD +
        "Feche o ciclo na origem da demanda: comente na issue contando o que foi entregue, com o link do PR e da "
        "documentação, e mova o item para \"Done\". O comentário segue o padrão do repositório, em quatro partes: "
        "**Entregue em produção** (PR e COMMIT/DEPLOYED_AT do recibo `.deploy-history/deploy-receipt-production.env`), "
        "**Evidências de validação** (testes pré-merge e fumaça em produção), **URLs/rotas afetadas**, "
        "**Pendências ou riscos**.\n"
        "Termine o comentário perguntando explicitamente se resolveu, e diga que, se não resolveu, basta reabrir a "
        "issue (ela volta a \"Todo\").\n"
        "Depois limpe o que a rodada criou: `git worktree remove --force ../nuria-wt-<issue>` (e o de revert, se "
        "existir), `git worktree prune`, `git branch -D fix/<issue>` (o remoto já apagou a branch no merge). "
        "Responda \"avisado\".",
    ),
    "avisar-falha": dict(
        timeoutMinutes=20, alwaysAllow=SHELL,
        instructions=H + BOARD +
        "A rodada não chegou ao fim. Olhe o histórico desta rodada para saber em que passo parou e por quê.\n"
        "- Se produção foi revertida, ou a tentativa de reverter falhou (rollback respondeu \"revertido\" ou \"falhou\"): "
        "abra uma issue NOVA \"Correção urgente: <título original>\", adicione-a ao board em \"Todo\" com o campo "
        "Source = \"Agent\", ligando à original e descrevendo o que falhou, com o trecho do log e o COMMIT do recibo.\n"
        "- Caso contrário (inclusive \"nada-a-reverter\"): comente na issue original explicando onde parou e mova o "
        "item de volta para \"Todo\".\n"
        "Não tente consertar nada aqui — o objetivo é que nenhuma demanda fique parada em silêncio. Responda \"avisado\".",
    ),
}

NEW_WAIT = {"espera-release": 15, "espera-rollback": 15}

EDGES = [
    ("triagem", "pegou", "spec"), ("triagem", "vazio", "sem-demanda"), ("triagem", "failed", "avisar-falha"),
    ("spec", "especificado", "codificacao"), ("spec", "failed", "avisar-falha"),
    ("codificacao", "pr-aberto", "testes-pre"), ("codificacao", "failed", "avisar-falha"),
    ("testes-pre", "passou", "revisao"), ("testes-pre", "falhou", "codificacao"), ("testes-pre", "failed", "avisar-falha"),
    ("revisao", "mergeado", "deploy"), ("revisao", "aguardar-humano", "aprovacao-merge"),
    ("revisao", "mudancas-pedidas", "codificacao"), ("revisao", "failed", "avisar-falha"),
    ("aprovacao-merge", "approved", "merge"), ("aprovacao-merge", "rejected", "avisar-falha"),
    ("merge", "mergeado", "deploy"), ("merge", "failed", "avisar-falha"),
    ("deploy", "publicado", "testes-prod"), ("deploy", "aguardando", "espera-release"),
    ("deploy", "falhou", "rollback"), ("deploy", "failed", "rollback"),
    ("espera-release", "elapsed", "deploy"),
    ("testes-prod", "passou", "doc"), ("testes-prod", "falhou", "rollback"), ("testes-prod", "failed", "rollback"),
    ("rollback", "revertido", "avisar-falha"), ("rollback", "aguardando", "espera-rollback"),
    ("rollback", "nada-a-reverter", "avisar-falha"), ("rollback", "falhou", "avisar-falha"),
    ("rollback", "failed", "avisar-falha"),
    ("espera-rollback", "elapsed", "rollback"),
    ("doc", "publicado", "update-canal"), ("doc", "failed", "update-canal"),
]


def main():
    raw = json.load(open(PATH))
    wfs = raw if isinstance(raw, list) else raw["workflows"]
    wf = next(w for w in wfs if w["id"] == WF_ID)
    before = json.dumps(wf, sort_keys=True)

    by_id = {n["id"]: n for n in wf["nodes"]}
    for nid, patch in NODES.items():
        n = by_id[nid]
        assert n["kind"] == "agent", nid
        n["instructions"] = patch["instructions"]
        n["timeoutMinutes"] = patch["timeoutMinutes"]
        n["alwaysAllow"] = list(dict.fromkeys(patch["alwaysAllow"]))
        if "outcomes" in patch:
            n["outcomes"] = patch["outcomes"]
    for wid, minutes in NEW_WAIT.items():
        if wid in by_id:
            by_id[wid]["minutes"] = minutes
        else:
            wf["nodes"].append({"kind": "wait", "id": wid, "minutes": minutes})
    wf["layout"].setdefault("espera-release", {"x": 2330.0, "y": -120.0})
    wf["layout"].setdefault("espera-rollback", {"x": 2982.0, "y": -560.0})
    wf["edges"] = [{"from": a, "outcome": o, "to": b} for a, o, b in EDGES]
    wf["maxNodeExecutions"] = 48
    wf["stuckAfterMinutes"] = 120
    wf["description"] = (
        "Pipeline do corredor local de release: triagem que normaliza o backlog, spec na issue, worktree por "
        "demanda, testes como portão do merge, aprovação humana só em mudanças sensíveis, merge commit (nunca "
        "squash), carrier de release e publicação pelo LaunchAgent com verificação do recibo, rollback por "
        "revert-PR, documentação a partir do PR e fechamento do ciclo na issue. Um run por vez; caminhos de falha explícitos.")
    wf["updatedAt"] = int(time.time() * 1000)

    changed = json.dumps(wf, sort_keys=True) != before
    ids = {n["id"] for n in wf["nodes"]}
    for a, o, b in EDGES:
        assert a in ids and b in ids, (a, b)
    print(f"nós={len(wf['nodes'])} arestas={len(wf['edges'])} maxNodeExecutions={wf['maxNodeExecutions']} mudou={changed}")
    if DRY:
        print("DRY_RUN=1 — nada gravado")
        return
    if not changed:
        print("já aplicado — nada a gravar")
        return
    bak = f"{PATH}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(PATH, bak)
    tmp = PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, PATH)
    print(f"gravado; backup em {bak}")


if __name__ == "__main__":
    main()
