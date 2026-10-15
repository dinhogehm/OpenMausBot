# Veltram: agentes, GitHub e execução de código

Esta receita usa fixtures descartáveis. Nunca insere tarefas artificiais no aplicativo publicado nem modifica o repositório do solicitante para comprovar o funcionamento.

## Verificações locais

Na pasta `cloudflare/app`, com Node 24 e pnpm:

```sh
pnpm check
pnpm test
node --test scripts/github-app-setup.test.mjs
pnpm build
pnpm exec wrangler deploy --dry-run --config wrangler.production.jsonc
```

Os testes de integração usam D1 e Durable Objects reais em workerd. Apenas os serviços externos de IA/GitHub e a VM são substituídos no teste do coordenador. Cobrem plano, programação, teste final com código de saída, revisão, correções com novo teste, aprovação, isolamento entre empresas, alteração/revogação de chaves, cancelamento, resposta GitHub perdida e reconciliação após reinício. Não fazem chamadas pagas a modelos nem criam PRs reais.

`web/test/ui-fixture.mjs` serve a interface real com respostas sintéticas em loopback. As verificações visuais cobrem desktop e 390 px, criação/aprovação/cancelamento, configuração dos três agentes, repositórios, membro sem privilégios e troca de empresa. As capturas comprovam a fixture, não uma sessão de produção.

## Imagem Linux e API nativa

```sh
docker build -f Dockerfile.coding -t veltram-coding-fixture:20261014 .
VELTRAM_DOCKER_TEST=1 node --experimental-strip-types --test test/coding-program.docker.test.ts
pnpm exec wrangler dev --config test/fixtures/coding-runtime-wrangler.jsonc --port 8897
```

Em outro terminal:

```sh
VELTRAM_NATIVE_URL=http://127.0.0.1:8897 node --experimental-strip-types --test test/coding-executor.native.test.ts
```

Usar armazenamento temporário próprio na invocação do Wrangler e encerrar somente o processo lançado para essa fixture. A entrada aceita apenas loopback e não é importada pela entrada de produção.

O teste cria um pequeno repositório sintético, observa um teste falhar, altera código, observa Node/Python passarem e compara os manifestos antes/depois. Também verifica download permitido, destino negado, diff, cancelamento e recusa de execução tardia. Comandos têm UID/GID 1000, capabilities zeradas e `NoNewPrivs`; não podem substituir Python/Git, seus módulos ou `.git`. Snapshot e diff encerram processos desse UID antes da leitura confiável. O teste mantém um escritor em segundo plano e comprova que ele parou.

## O que uma publicação comprova

Identificador de release, versão Cloudflare ativa, migrações, HTTPS e hashes dos assets comprovam qual código foi publicado. Uma fixture remota isolada comprova o runtime na infraestrutura Cloudflare. Nenhum desses sinais comprova, sozinho, que uma empresa conectou o GitHub ou que um modelo real gerou um PR.

Após a [configuração autorizada da GitHub App](veltram-github-setup.md), conferir por leitura a conta e o único repositório solicitado. Uma primeira tarefa real precisa de objetivo e comandos de preparação/teste definidos. O recibo deve ligar tarefa, SHA de origem, arquivos testados, saída do teste e PR em rascunho. O Veltram não faz merge nem deploy do repositório conectado.

## Limites iniciais

- Equipe fixa de três papéis, personalizável; modelos OpenAI, Anthropic e OpenRouter com chaves da empresa.
- JavaScript/TypeScript e Python; arquivo de um commit, sem histórico anterior, submódulos, LFS ou links simbólicos. Metadados Git são protegidos; comandos que modificam o índice local não são suportados.
- Sem alteração de workflows, daemons persistentes ou registries privados. Rede limitada a dependências públicas, até 1 GiB e 2.000 requisições por tarefa.
- 30 minutos por tarefa, 10 minutos por comando, 30 chamadas de IA, 240 mil tokens; até 100 arquivos alterados e 10 MiB. Esses limites não representam um preço fixo.
- Uma tarefa ativa por empresa, quatro no conjunto, histórico de até 100 tarefas por empresa; retenção móvel ainda não implementada.
- Efeitos sem recibo após reinício não são repetidos. Uma publicação incerta é consultada sem escrever novamente; se o GitHub continuar indisponível, a interface informa incerteza e exige conferência antes de nova tarefa.
