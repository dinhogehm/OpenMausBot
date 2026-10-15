# Veltram: missões, orçamento e conexões pessoais

## Comportamento da versão 2026-10-15.1

A seção **Conexões de IA** separa chaves de API da empresa e assinaturas pessoais. Uma conexão pessoal pertence ao usuário autenticado dentro da empresa; não pode ser usada por outro membro. Seleção de fonte é explícita, presa à versão da conexão, sem fallback silencioso para API paga.

**As assinaturas ainda não estão disponíveis para execução.** A configuração de produção mantém `CLAUDE_CODE_ENABLED=false`. O CLI original do Claude passou os testes básicos de saída estruturada e bloqueio das ferramentas do modelo, mas executou hooks gerenciados nos testes adversariais mesmo com as opções restritivas. Isso impede a ativação: não é uma integração qualificada. O login real e a aceitação das condições aplicáveis pelo titular ainda não aconteceram. O ChatGPT depende da habilitação oficial da OpenAI para uso hospedado; a interface informa essa dependência e não reutiliza o registro de outro aplicativo.

O orçamento é por empresa, com padrão de R$ 1.000 por dia em America/Sao_Paulo. Administradores podem alterá-lo. Valores inteiros, reservas serializadas e identificadores de operação impedem gasto concorrente acima do saldo estimado; resultados incertos continuam reservados. Preços e câmbio têm procedência. Isso cobre inferência de API estimada em reais, sem incluir assinatura, uso extra nativo, infraestrutura, impostos ou diferenças da fatura.

Produção usa `AI_BUDGET_REQUIRED=true`. **Chamadas pagas de API, inclusive navegador e Jev, permanecem pausadas enquanto a cobrança da credencial não for qualificada.** O adaptador inicial suporta OpenRouter com créditos qualificados; um recibo sem custo upstream não comprova ausência de BYOK. Não há credencial qualificada nem caminho de autoatestação nesta versão. O campo `paidApiAvailable` continua falso. Não confundir o saldo configurado com autorização para executar.

Missões persistem objetivo, critérios, fila declarada pelo administrador e evidências. Reinícios reconciliam a mesma tentativa antes de novas ações; pausa impede novas tarefas e cancelamento guarda fatos tardios. Não há planner autônomo pago nesta fase. A política de merge e publicação para em `awaiting_delivery` até existir adaptador qualificado do projeto. O executor canônico de produção da Nuria continua local e não foi substituído.

Graft 0.22.0 está fixado na imagem de programação. Mapa, busca, estrutura e referências funcionam sem rede/modelo adicional durante a análise. Índices ficam fora do checkout e são atualizados após edição. Saídas são limitadas; ausência de resultado não prova ausência de código e o agente deve ler o trecho antes de editar.

## Evidências isoladas

- 95 testes unitários e 221 de integração passaram; tipos, build, lint sem avisos e verificação de whitespace passaram.
- A suíte inclui concorrência no último saldo, virada de dia, cobrança tardia, estado incerto, cancelamento durante persistência e antes do envio, isolamento de usuário/empresa e reconciliação de missões.
- Graft: cinco testes dedicados, uma prova Docker e a [prova nativa na Cloudflare](evidence/veltram-coding-proof-7a28eea3073b.json). A fixture temporária foi removida e sua URL retornou 404.
- Claude: [prova de snapshot e restauração na Cloudflare](evidence/veltram-claude-proof-60cdf9c513b7.json), sem login ou inferência paga. Isso não qualifica o isolamento da inferência.
- O [bloqueador de hooks gerenciados](evidence/veltram-claude-managed-hooks-blocker.json) preserva duas provas nativas aprovadas e três reprovadas. A suíte opcional `test:claude:native` permanece vermelha, intencionalmente, até corrigir o limite de isolamento. Não omitir essas falhas ao avaliar ativação.
- Os recibos nativos registram hashes das fontes exercitadas. Depois dessas provas houve apenas a remoção de um escape redundante de hífen no validador de código de login; os 95 testes unitários foram repetidos. Não apresentar os recibos anteriores como prova byte a byte de um build posterior.
- QA visual em fixture isolada: criação, pausa, retomada e cancelamento de missão, espera por publicação, troca de empresa sem privilégios e celular de 390 px sem overflow.

Nenhuma credencial pessoal foi copiada; nenhuma chamada paga de IA, tarefa real, merge ou publicação do repositório Nuria foi executada para validar estas mudanças.

## Reproduzir

```sh
pnpm --dir cloudflare/app check
pnpm --dir cloudflare/app test
pnpm --dir cloudflare/app test:graft
pnpm --dir cloudflare/app test:graft:docker
pnpm exec oxlint --deny-warnings cloudflare/app
pnpm --dir cloudflare/app build
pnpm --dir cloudflare/app exec wrangler deploy --config wrangler.production.jsonc --dry-run
```

As provas remotas provisionam recursos temporários e exigem a conta de teste autorizada. Nunca executar mutações de teste na aplicação/dados reais. Para Claude, a prova adversarial deve ser repetida após mudar a fronteira de isolamento; só ativar quando passar e os demais requisitos de hospedagem estiverem resolvidos.

## Publicação verificada

`veltram-2026-10-15.1`, runtime `df2a2f32bdd04cd76843bc50eb9046a6a0e1bb48`, está em produção desde 2026-10-15T03:28:24.887372Z, com 100% do tráfego. A versão Cloudflare é `0242b15f-a2ee-4da9-a8b2-f93575b1efdf`. Saúde, HTML e hashes de JavaScript/CSS coincidiram com o build local; a sessão autenticada da Nuria mostrou os estados bloqueados, orçamento de R$ 1.000 e lista de missões vazia carregada. Não há migrações D1 pendentes.

O [recibo de produção](evidence/2026-10-15-veltram-continuous-production.json) distingue publicação da interface, controle de orçamento e ferramentas de contexto da ativação das assinaturas e da execução autônoma efetiva, que continuam pendentes. O [PR #21](https://github.com/dinhogehm/OpenMausBot/pull/21) permanece em rascunho com esses bloqueios explícitos.
