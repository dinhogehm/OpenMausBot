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

## Evidências de 14/10/2026

- 70 testes unitários, 93 de integração e dois da configuração do operador aprovados. Tipos do backend/frontend, lint, build e dry-run de produção aprovados. Hooks de push do repositório (lint, tipos e catálogos) aprovados.
- Revisão independente confirmou o fechamento da substituição de ferramentas do runtime e da perda de recibo de PR em cancelamento/reinício. Os testes do coordenador incluem 18 cenários, com serviços externos simulados.
- [Prova remota final](evidence/veltram-coding-proof-df7240d01cee.json): uma VM real na Cloudflare executou o teste nativo em 23 segundos, incluindo um arquivo original de 24 MiB, privilégio removido, ferramentas protegidas, encerramento de processos em segundo plano, rede, edição, teste, diff, manifesto e cancelamento. Os hashes do recibo coincidem com os fontes do commit `4675f331db43303f16d824c308c16d841eaf725f`.
- A fixture rejeitou credencial ausente/incorreta e empresa incorreta com 403. Worker, aplicação de contêiner e imagem temporários foram removidos, com inventários vazios e sem erro de limpeza. Não havia D1, GitHub, modelo pago ou dados de produção associados à fixture.
- A primeira tentativa parou em 404 durante a propagação de `workers.dev`, sem iniciar o teste; seus recursos foram removidos. O runner agora aguarda disponibilidade de modo limitado. Os recibos preservam tanto essa tentativa quanto as duas provas aprovadas, sem apresentá-las como equivalentes.

## Publicação e conexão verificadas

O [recibo de produção](evidence/2026-10-14-veltram-coding-production.json) registra a release `veltram-2026-10-14.3`, do commit de runtime `4675f331db43303f16d824c308c16d841eaf725f`. A versão Cloudflare `50c6cf46-9dc8-432f-9e23-4044367ce78d` recebeu 100% do tráfego no deployment `69af0c85-a967-42de-a8fa-24b7565cc312`, criado em `2026-10-15T01:24:23.80072Z` (14/10, às 22:24 em Brasília). As migrações `0003_github.sql` e `0004_agents.sql` foram aplicadas; a conferência não encontrou migrações pendentes.

Em `https://veltram.com`, saúde e página responderam 200, e os hashes do JavaScript e CSS publicados coincidiram com o build local. Na sessão de navegador autorizada, a GitHub App `VeltramApp` (ID `5324149`, slug `veltramapp`, instalação `171559276`) foi instalada somente em `dinhogehm/nuria-platform`. OAuth e seleção foram concluídos na empresa Nuria; a interface mostrou o repositório conectado, branch padrão `main`, e os três agentes disponíveis.

A publicação e a conexão estão comprovadas. Nenhuma tarefa real de IA foi executada nem PR produzido por esses agentes no repositório conectado. A prova remota acima usa fonte sintética e verifica o executor isolado; os testes do coordenador usam respostas de modelos e GitHub simuladas. O recibo de produção não contém e-mails, cookies, tokens ou capturas de tela.

## Limites iniciais

- Equipe fixa de três papéis, personalizável; modelos OpenAI, Anthropic e OpenRouter com chaves da empresa.
- JavaScript/TypeScript e Python; arquivo de um commit, sem histórico anterior, submódulos, LFS ou links simbólicos. Metadados Git são protegidos; comandos que modificam o índice local não são suportados.
- A fonte aceita arquivo compactado de até 64 MiB, até 20 mil entradas e 512 MiB expandidos, com 64 MiB por arquivo existente. A inspeção somente leitura de `nuria-platform` no SHA `202df064740b5bba7947de8102a34c198d85756f` encontrou 12.431 arquivos/198.653.838 bytes, incluindo um arquivo gerado de 46.529.568 bytes; o arquivo tar.gz local desse commit mede 49.332.322 bytes. Isso verifica compatibilidade de tamanho, não uma execução de tarefa nesse repositório.
- Sem alteração de workflows, daemons persistentes ou registries privados. Rede limitada a dependências públicas, até 1 GiB e 2.000 requisições por tarefa.
- 30 minutos por tarefa, 10 minutos por comando, 30 chamadas de IA, 240 mil tokens; até 100 arquivos alterados e 10 MiB. Esses limites não representam um preço fixo.
- Uma tarefa ativa por empresa, quatro no conjunto, histórico de até 100 tarefas por empresa; retenção móvel ainda não implementada.
- Efeitos sem recibo após reinício não são repetidos. Uma publicação incerta é consultada sem escrever novamente; se o GitHub continuar indisponível, a interface informa incerteza e exige conferência antes de nova tarefa.
