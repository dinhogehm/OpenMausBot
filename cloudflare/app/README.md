# Veltram

Aplicativo web para várias empresas na Cloudflare, publicado em [veltram.com](https://veltram.com), com Worker, interface e recursos próprios. A versão `veltram-2026-10-15.2` inclui acesso por e-mail, empresas, chaves, agentes de programação e conexão com GitHub, com revisão integral da interface e proteção dos fluxos de trabalho. O repositório `dinhogehm/nuria-platform` está conectado à empresa Nuria; ainda não foi executada uma tarefa real de IA nem criado um PR por esses agentes. O [desenho da reconstrução](../../docs/plans/2026-10-14-cloudflare-reconstruction-design.md) registra as decisões, e o [plano GitHub/agentes](../../docs/plans/2026-10-14-veltram-github-agents.md) descreve a evolução.

## Estado atual

- Interface React servida pelo Worker, com login por código de e-mail, cookie HttpOnly, logout, criação/troca de empresa e administração de chaves.
- D1 com empresas, papéis por usuário e workspace inicial.
- Chaves próprias de OpenAI, Anthropic e OpenRouter por empresa, criptografadas com AES-256-GCM. Empresa, provedor, identificador e versão autenticam o ciphertext. Nenhuma rota devolve a chave original.
- Substituição com versão esperada e auditoria transacional. Revogação remove o ciphertext ativo. `configured` significa armazenada, não validada pelo provedor.
- Limites: 10 empresas por proprietário; 5 envios de código/minuto/IP e 5/10 minutos/destinatário; 30 tentativas de cadastro/substituição de chave por hora/empresa. Revogação permanece disponível com a cota cheia.
- Prova de execução Linux com aprovação explícita, histórico e resultado na interface. Um programa fixo grava e lê um arquivo; isso não é uma conversa com IA nem execução arbitrária de shell.
- `ExecutionRoom` persiste estado e aprovações por empresa em Durable Object. `Admission` limita a uma execução por empresa, quatro no conjunto e 30 admissões por hora no conjunto. O histórico aceita 100 provas no total por empresa; esta etapa ainda não implementa retenção móvel ou remoção.
- Cada tentativa usa um `LinuxExecutor` próprio, com rede externa desligada e sem chaves de provedores. A concessão tem prazo absoluto de 60 segundos a partir da aprovação; o executor usa o menor prazo entre esse limite e 45 segundos após recebê-la, incluindo preparação e execução.
- Cancelamento invalida a geração anterior. Uma vaga só é liberada após confirmação da parada do executor, inclusive quando sua concessão expirou. Recuperação após despacho incerto marca interrupção e não repete comandos; uma chamada idêntica já concluída pode devolver o recibo persistido sem executar novamente.

Ainda não há convites/gestão de membros, conversas gerais, R2 ou rotinas. Os testes inserem membros adicionais apenas em fixture. O pacote não importa dados, chaves ou código enterprise do aplicativo existente.

## Agentes de programação publicados

- Equipe pronta com coordenador, programador e revisor. Administradores personalizam nomes, instruções e modelos; tarefas congelam essa configuração na criação. O coordenador entrega um plano estruturado; o revisor recebe apenas leitura e precisa emitir um parecer explícito.
- GitHub App com OAuth PKCE, seleção explícita de repositórios, vínculo único de instalação por empresa, comprovação de proprietário e revogação por webhook. O [procedimento do operador](../../docs/verification/veltram-github-setup.md) registra exatamente as permissões e a instalação.
- BYOK real com protocolos OpenAI Responses, Anthropic Messages e OpenRouter Chat Completions. Credenciais e tokens GitHub ficam nos Workers; código do repositório não os recebe.
- Uma VM descartável por tarefa/geração com Node, pnpm, Python e Git. Código fixado por SHA, ferramentas limitadas, dependências públicas permitidas explicitamente, comandos de preparação e teste aprovados pelo usuário. LFS, submódulos e registries privados não têm suporte inicial.
- A fonte é um arquivo do commit escolhido, com baseline Git local; o histórico anterior não é baixado. Comandos que dependem de tags ou commits antigos precisam de suporte adicional. Arquivos especiais e links simbólicos são recusados nesta versão.
- Comandos do repositório executam sem privilégios; Python, Git e o baseline são protegidos. Processos em segundo plano são encerrados antes de snapshot/diff. Metadados Git locais são imutáveis; branches e PRs são criados pelo broker externo.
- Após as alterações, o comando de teste final roda de fato; os manifestos antes/depois devem coincidir. Falha de teste ou revisão devolve trabalho ao programador dentro de limites. O broker publica o manifesto validado em branch exclusiva e abre PR em rascunho; não faz merge nem deploy do repositório conectado.
- Limites iniciais: 30 minutos, 30 chamadas de modelo e 240 mil tokens por tarefa, até 100 arquivos alterados/10 MiB, 1 MiB por arquivo. Uma tarefa ativa por empresa, quatro no conjunto; o histórico mostra todas as tarefas não terminadas e as 100 terminadas mais recentes por workspace; isso não é uma política de remoção dos registros antigos. Os limites de tokens não equivalem a um preço fixo.
- Cancelamento persiste geração e impede efeitos posteriores. Uma etapa sem recibo após reinício fica interrompida. A capacidade só é liberada após a parada confirmada da VM. Logs e manifestos ficam em armazenamento privado do coordenador com limites; não há endpoint público de artefatos.

Essas capacidades exigem a App registrada/instalada e chaves de IA fornecidas pela empresa. A GitHub App `VeltramApp` está instalada somente em `dinhogehm/nuria-platform`, e a autorização OAuth e a seleção desse repositório foram concluídas na interface de produção. Os três agentes estão visíveis. Testes com provedores simulados e repositórios descartáveis não certificam uma chamada real de IA no repositório escolhido.

A [receita de verificação dos agentes](../../docs/verification/veltram-coding.md) descreve os testes, os limites e a distinção entre publicação, conexão e execução real.

## API

Todas as rotas de dados exigem sessão de usuário com e-mail verificado. Mutações exigem `Origin` igual a `APP_ORIGIN`, JSON e corpo de até 8 KiB (32 KiB em tarefas, 64 KiB em perfis). O webhook GitHub é uma exceção específica autenticada por HMAC do corpo bruto. Respostas privadas não são cacheáveis. Não há suporte a bearer.

| Método | Rota | Uso |
| --- | --- | --- |
| POST | `/api/auth/email-otp/send-verification-otp` | `{email, type: "sign-in"}` |
| POST | `/api/auth/sign-in/email-otp` | `{email, otp}`; define cookie e responde `{success: true}` |
| POST | `/api/auth/sign-out` | `{}`; revoga sessão |
| GET | `/api/session` | Dados básicos do usuário; sem token |
| GET/POST | `/api/organizations` | Listar próprias empresas / criar com `{name}` |
| GET | `/api/organizations/:id/workspaces` | Workspaces da empresa |
| GET | `/api/organizations/:id/credentials` | Somente metadados |
| PUT | `/api/organizations/:id/credentials/:provider` | Administrador: `{key, expectedVersion}` |
| DELETE | `/api/organizations/:id/credentials/:provider` | Administrador: `{expectedVersion}` |
| GET/POST | `/api/organizations/:id/workspaces/:workspaceId/runs` | Listar provas / criar com `{requestId, message, delayMs}` |
| GET | `/api/organizations/:id/workspaces/:workspaceId/runs/:runId` | Estado e resultado persistidos |
| POST | `/api/organizations/:id/workspaces/:workspaceId/runs/:runId/approve` | Administrador: `{}`; persiste aprovação antes do despacho |
| POST | `/api/organizations/:id/workspaces/:workspaceId/runs/:runId/cancel` | Administrador ou autor da prova: `{}` |
| GET/PUT | `/api/organizations/:id/agents` | Equipe e atualização administrativa com `expectedVersion` |
| GET | `/api/organizations/:id/github` | Configuração, conexões e seleção OAuth pendente |
| POST | `/api/organizations/:id/github/connect` | Iniciar autorização GitHub |
| POST/DELETE | `/api/organizations/:id/github/repositories[/:connectionId]` | Selecionar/revogar repositório |
| GET/POST | `/api/organizations/:id/workspaces/:workspaceId/coding-runs` | Listar/criar tarefas com aprovação pendente |
| GET | `/api/organizations/:id/workspaces/:workspaceId/coding-runs/:runId` | Estado, equipe, comandos, testes e PR |
| POST | `/api/organizations/:id/workspaces/:workspaceId/coding-runs/:runId/approve` | Administrador: `{generation}` |
| POST | `/api/organizations/:id/workspaces/:workspaceId/coding-runs/:runId/cancel` | Autor/administrador: `{generation}` |

`expectedVersion` é `null` apenas no primeiro cadastro; depois corresponde à versão observada nos metadados, inclusive após revogação. Uma disputa retorna 409. O cliente deve atualizar os metadados e solicitar a decisão do usuário, sem repetir cegamente a alteração.

Na criação de prova, `requestId` é um UUID; repetir a mesma solicitação devolve o registro existente, enquanto reutilizar o identificador com outro conteúdo é recusado. A mensagem tem de 1 a 1.000 caracteres e o atraso vai de 0 a 30.000 ms. O resultado deve corresponder exatamente à mensagem e ter código de saída zero para sucesso. `GET /api/health` é público e informa serviço, estado e identificador da versão; não comprova fluxo funcional.

## Verificação isolada

Na raiz, com Node 24 e pnpm:

```sh
pnpm install --filter @openmausbot/cloud-app --frozen-lockfile --ignore-scripts
pnpm --filter @openmausbot/cloud-app test
pnpm --filter @openmausbot/cloud-app check
pnpm --filter @openmausbot/cloud-app dry-run
```

Os testes lançam workerd com D1 temporário, remetente simulado e substitutos controlados do executor. A aceitação adicional com Wrangler e Docker locais exercita o executor nativo real. As credenciais são sintéticas. Não há envio real de e-mail, chamada paga de IA ou acesso aos dados do usuário. A [receita de verificação](../../docs/verification/cloud-app.md) inclui a fixture de navegador com armazenamento descartável e os limites de cada prova.

A rodada final em 14/10/2026 aprovou 70 testes unitários, 93 de integração e dois da configuração do operador, além de verificação de tipos, lint, build da interface, dry-run de produção e hooks de push. A [prova remota final dos agentes](../../docs/verification/evidence/veltram-coding-proof-df7240d01cee.json) confirmou edição, teste inicialmente falhando e depois passando, diff, manifesto, remoção de privilégios, proteção das ferramentas, rede limitada e cancelamento em uma VM real na Cloudflare. Worker, aplicação de contêiner e imagem dessa fixture foram removidos, com inventários vazios. A [prova Linux anterior](../../docs/verification/evidence/2026-10-14-veltram-linux.json) permanece como evidência da primeira versão. Consulte a receita de verificação para separar as evidências locais, da fixture remota e do aplicativo publicado.

## Publicação e configuração

`wrangler.jsonc` continua reservado ao desenvolvimento, com banco fictício, remetente reservado e origem localhost. A publicação usa explicitamente `wrangler.production.jsonc`, que aponta para recursos exclusivos do Veltram, `APP_ORIGIN=https://veltram.com`, remetente `noreply@veltram.com` e o domínio do Worker. O D1 recebeu as quatro migrações até `0004_agents.sql`, sem migrações pendentes na conferência da publicação. `AUTH_SECRET`, `CREDENTIAL_MASTER_KEY` e as credenciais da GitHub App estão instalados como segredos. Nunca colocar seus valores em `vars`, no repositório ou na imagem do executor. Os valores fixos das fixtures são sintéticos e proibidos em produção.

Para uma publicação revisada, na raiz do worktree, após os testes e atualização do identificador de versão:

```sh
pnpm --filter @openmausbot/cloud-app build
pnpm --filter @openmausbot/cloud-app exec wrangler deploy --dry-run --config wrangler.production.jsonc
pnpm --filter @openmausbot/cloud-app exec wrangler deploy --config wrangler.production.jsonc
```

Aplicar migrações remotas somente quando houver mudanças revisadas de schema: `pnpm --filter @openmausbot/cloud-app exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`. Não regenerar segredos em publicação de rotina. Rotacionar `AUTH_SECRET` afeta sessões; trocar a chave mestra sem recriptografar dados impede a leitura das credenciais existentes.

A versão atual é `veltram-2026-10-15.2`, runtime `f4892e32b84206c77bb24d2284bb4c101e4fe6fc`, versão Cloudflare `1d76927c-6c61-4dec-ba14-01739399f941`, com 100% do tráfego. HTTPS, saúde, HTML e hashes dos assets foram conferidos em `https://veltram.com`. A interface inclui missões declaradas, orçamento diário e conexões pessoais; Graft está na imagem de programação. **Claude permanece desativado por um bloqueio de isolamento; ChatGPT aguarda habilitação oficial; chamadas pagas de API estão pausadas até qualificar a cobrança. Não há prova de autonomia 24/7.** Os [limites e testes](../../docs/verification/veltram-continuous-llm.md) e o [recibo atual](../../docs/verification/evidence/2026-10-15-veltram-quality-production.json) detalham esses estados. O [recibo anterior de programação](../../docs/verification/evidence/2026-10-14-veltram-coding-production.json) e a [receita inicial](../../docs/verification/cloud-app.md) preservam o histórico.

Workers Paid foi confirmado como plano atual no dashboard em 14/10/2026; não é necessária uma nova contratação. Containers e envio de e-mail para destinatários arbitrários usam esse plano, cujo mínimo divulgado é US$5/mês por conta. A inclusão de um novo projeto não cria outra mensalidade, mas o consumo e as franquias são compartilhados com outros projetos. Há 3.000 e-mails/mês incluídos por conta, depois US$0,35/1.000; Containers e armazenamento/consultas excedentes são cobrados por uso. Acompanhar consumo e orçamento da prova; os limites técnicos acima não são um teto financeiro. [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/).

Substituir a chave mestra sem recriptografar as credenciais impede sua leitura. O procedimento de rotação, retenção de backups e recuperação ainda precisa ser implementado e testado. Revogar aqui remove a cópia ativa; não revoga a chave na conta do provedor nem apaga backups antigos.

O broker confere associação, permissão, versão da credencial e limites em cada chamada. A chave de longa duração não entra no ambiente que executa código. Testes locais e dry-run não comprovam operação na nuvem.

A [revisão de qualidade](../../docs/verification/veltram-quality.md) registra testes, inspeções por área, capturas sintéticas e as verificações interativas pendentes por bloqueio de uma extensão do navegador. A nova versão foi comprovada por saúde, HTML e hashes públicos; a sessão autenticada de produção não foi reinspecionada nesta rodada. Nenhuma alegação de certificação AAA ou autonomia contínua decorre dessa publicação.
