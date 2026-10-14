# Veltram

Aplicativo web em desenvolvimento para várias empresas na Cloudflare. `veltram.com` foi registrado em 14/10/2026; o aplicativo continua somente local. O [desenho da reconstrução](../../docs/plans/2026-10-14-cloudflare-reconstruction-design.md) registra decisões e referências, e o [plano do primeiro fluxo](../../docs/plans/2026-10-14-veltram-first-workflow.md) delimita esta etapa.

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

Ainda não há convites/gestão de membros, bots, conversas com IA, broker de modelos, R2, rotinas ou publicação. Os testes inserem membros adicionais apenas em fixture. O pacote não importa dados, chaves ou código enterprise do aplicativo existente.

## API

Todas as rotas de dados exigem sessão de usuário com e-mail verificado. Mutações exigem `Origin` igual a `APP_ORIGIN`, JSON e corpo de até 8 KiB. Respostas privadas não são cacheáveis. Não há suporte a bearer.

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

A rodada consolidada em 14/10/2026 aprovou 91 testes (53 unitários e 38 de integração), verificação de tipos, build da interface, dry-run do Worker, oxlint sem avisos e `git diff --check`. Essa evidência valida a etapa local; não comprova publicação.

## Antes de publicar

`wrangler.jsonc` usa ID de banco inexistente, remetente reservado e origem localhost. Preparar D1 e Durable Objects exclusivos do Veltram, definir `APP_ORIGIN=https://veltram.com`, conectar o domínio ao Worker, configurar o domínio remetente, gerar `AUTH_SECRET` aleatório e `CREDENTIAL_MASTER_KEY` de 32 bytes em base64 como segredos exclusivos do Worker. Nunca colocar segredos reais em `vars`, no repositório ou na imagem do executor. Os valores fixos da fixture são públicos, sintéticos e proibidos em produção.

A auditoria somente leitura de 14/10/2026 confirmou acesso OAuth aos serviços necessários, nenhum Container configurado na conta e nenhum remetente de Email Sending configurado para `veltram.com`. Não criou recursos nem enviou e-mails. O registro do domínio não publica o app nem habilita o remetente. O onboarding de envio pode ser feito com `wrangler email sending enable veltram.com`, seguido das consultas `settings` e `dns get`; não executar essa preparação como parte dos testes locais.

Workers Paid foi confirmado como plano atual no dashboard em 14/10/2026; não é necessária uma nova contratação. Containers e envio de e-mail para destinatários arbitrários usam esse plano, cujo mínimo divulgado é US$5/mês por conta. A inclusão de um novo projeto não cria outra mensalidade, mas o consumo e as franquias são compartilhados com outros projetos. Há 3.000 e-mails/mês incluídos por conta, depois US$0,35/1.000; Containers e armazenamento/consultas excedentes são cobrados por uso. Acompanhar consumo e orçamento da prova; os limites técnicos acima não são um teto financeiro. [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/).

Substituir a chave mestra sem recriptografar as credenciais impede sua leitura. O procedimento de rotação, retenção de backups e recuperação ainda precisa ser implementado e testado. Revogar aqui remove a cópia ativa; não revoga a chave na conta do provedor nem apaga backups antigos.

Antes de integrar agentes, o broker deverá conferir associação, permissão, versão da credencial e limites em cada chamada. A chave de longa duração não deve entrar no ambiente que executa código. Testes locais e dry-run não comprovam operação na nuvem.
