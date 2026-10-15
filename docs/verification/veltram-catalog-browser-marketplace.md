# Veltram: catálogo, relatórios, navegador e marketplace

Esta receita registra implementação e validação em fixtures da etapa descrita no [plano](../plans/2026-10-14-veltram-catalog-reports-kanban.md). **Não é um recibo de publicação.** A prova remota abaixo usou um Worker temporário e um site sintético; não alterou o aplicativo de produção nem o repositório conectado do usuário.

O Veltram ainda não opera autonomamente 24/7. Merge e publicação dos repositórios, teto diário em reais, Graft no produto e conexão de assinaturas de LLM pertencem ao próximo escopo do plano e não estão comprovados por esta entrega.

## Escopo da implementação em validação

- Catálogo privado de perfis por empresa, edição, importação JSON com campos permitidos e escolha dos três papéis. Credenciais, sessões e histórico do OMB não fazem parte da importação. Referências ao modelo do desktop são informativas; a tarefa usa sua configuração de IA na nuvem. Limites: 100 perfis, catálogo de 256 KiB e instruções de até 20.000 bytes UTF-8 por perfil.
- Jev como serviço de recomendação separado da execução, com chave própria por empresa e escolha revisável. Salvar a chave não valida a conexão; a probabilidade exibida corresponde à escolha retornada, sem substituir testes ou revisão.
- Kanban derivado do estado real das tarefas e relatórios com fontes, cobertura, comparação de períodos, metas e exportações. Tokens observados são distintos de reservas; backlog é uma fotografia atual. PR confirmado não comprova merge nem produção. Custo faturado e métricas de produção/DORA sem fonte aparecem como não acompanhados.
- Navegador Cloudflare com tarefa aprovada, sessão própria, modelo BYOK com visão, hosts exatos autorizados, captura autenticada e cancelamento. Limites atuais por tarefa: cinco minutos, 20 ações, 20 chamadas e orçamento de 60 mil tokens. Não importa sessões do Mac nem oferece controle de aplicativos nativos ou transferência interativa de login.
- Marketplace de perfis de compatibilidade OMB e referências públicas Grok Bot. As seis equipes OMB contêm 18 perfis; as 90 referências Grok não instalam conteúdo. A [licença e procedência](../../cloudflare/app/marketplace-NOTICE.md) acompanham o snapshot. Instalar perfis não instala plugins, ativa rotinas, conecta contas nem concede permissões.

## Verificação local isolada

Na raiz do worktree, com Node 24 e pnpm:

```sh
pnpm --filter @openmausbot/cloud-app check
pnpm --filter @openmausbot/cloud-app test
pnpm --filter @openmausbot/cloud-app build
node --experimental-strip-types cloudflare/app/web/test/agents-reports-fixture.mjs
```

A fixture imprime uma URL `http://127.0.0.1:PORT` e mantém suas alterações em memória. Usar essa URL explícita no CUA para verificar a interface real. Os 12 perfis de exemplo, empresas, chaves, tarefas, capturas e relatórios são sintéticos; os metadados do marketplace vêm do bundle público revisado. Encerrar somente o processo lançado para essa fixture. Não usar a sessão publicada do usuário para testes de mutação.

Os testes de integração usam workerd/D1 com serviços externos substituídos. Cobrem versões e idempotência do catálogo, autorização administrativa, isolamento, Jev inválido ou indisponível, fatos e cobertura dos relatórios, instalação repetida e preservação de personalizações. No navegador, cobrem criação/aprovação/cancelamento, mudança de chave, despacho incerto após reinício, prazo absoluto, reserva de tokens, registro de uso antes de falha da ação e respostas tardias que não podem afetar a próxima tarefa.

A confirmação independente dos arquivos `browser-boundaries.integration.test.ts`, `browser-room.integration.test.ts` e `reports-boundaries.integration.test.ts` passou **18/18**. A regressão posterior de `model-broker.integration.test.ts` passou **8/8**: cada provedor recusa um 307 externo após uma única chamada no endpoint fixo, sem seguir `Location` ou encaminhar a chave. Esses conjuntos são focados e não substituem a suíte completa dos fontes finais.

A rodada completa final registrada pelo responsável pela entrega passou **88/88 testes unitários e 149/149 de integração**. Os hashes de runtime/rede/estado/tipos do recibo remoto `9ac4eb946ebb` foram conferidos contra os fontes atuais. Esses resultados registram validação; a publicação do aplicativo requer evidência própria.

## QA de interface registrada

A verificação em fixture via CUA confirmou Kanban, relatórios, exportação Markdown, troca de empresa e criação/aprovação/cancelamento de tarefa do navegador. O marketplace instalou uma equipe com quatro perfis uma única vez; a repetição ficou desabilitada. Ao mudar para outra empresa com papel membro, a instalação ficou indisponível. A visualização móvel permaneceu legível.

As demais verificações de catálogo, Jev, relatórios e as pendências de teclado, falhas e impressão/PDF estão no [plano de QA](../plans/2026-10-14-veltram-catalog-reports-kanban.md#evidências-e-pendências-de-qa-desta-etapa). A captura e os resultados dessa fixture não demonstram que um modelo real executou uma tarefa.

## Prova nativa do navegador na Cloudflare

O [recibo `veltram-browser-proof-9ac4eb946ebb.json`](evidence/veltram-browser-proof-9ac4eb946ebb.json) registra a execução de `2026-10-15T02:20:46.117Z` a `2026-10-15T02:21:21.936Z` (14/10, 23:20–23:21 em São Paulo). O mesmo adaptador de navegador e proxy usado pelo aplicativo foi executado em um Worker descartável, com hashes dos fontes no recibo.

| Verificação | Resultado observado |
| --- | --- |
| Credencial ausente e incorreta da fixture | HTTP 403 em ambos os casos |
| Prova autorizada | HTTP 200; nenhuma falha declarada |
| Proxy para o site sintético | HTTP 200, 983 bytes |
| Preenchimento e clique | Texto observado: `Confirmed: cloud-isolated-proof` |
| Captura JPEG | 17.864 bytes |
| WebSocket nativo no próprio host | Bloqueado, sem mensagem do servidor |
| Recurso de host externo | Bloqueado pela interceptação |
| Navegação fora dos hosts autorizados | Recusada |
| Sessão | Fechamento e término confirmados |
| Worker temporário | Exclusão com código 0; rota respondeu HTTP 404 depois |

Não houve chamadas pagas a modelos, importação de perfis privados, acesso ao GitHub ou ligação com o banco da aplicação nessa prova. O uso de Browser Run é real; o conteúdo e as ações são sintéticos. O resultado comprova o adaptador e essas fronteiras de rede na revisão identificada pelos hashes, não uma tarefa completa guiada por IA nem uma disponibilidade contínua 24/7.

As tentativas anteriores permanecem nos recibos como falhas de diagnóstico. Elas identificaram que o runtime Cloudflare exige `redirect: "manual"` para este fluxo e que a consulta de uma sessão encerrada pode devolver o erro específico `Session not found (status=404)`. A implementação recusa respostas de redirecionamento dos provedores; o proxy valida o destino antes de devolver um redirecionamento permitido ao navegador. A normalização de sessão trata somente o erro nativo comprovado, sem considerar falhas genéricas de transporte como fechamento.

Para repetir a prova, o operador precisa de autorização para criar recursos temporários na conta Cloudflare. O runner é `cloudflare/app/test/browser-runtime.remote.mjs`, com opt-in `VELTRAM_REMOTE_PROOF=1`. Ele cria autenticação efêmera, registra hashes, executa o site sintético e remove o Worker. Conferir tanto `sessionClosed`/`sessionConfirmedEnded` quanto `workerDeleteExit`/`finalHttpStatus`; uma resposta parcial ou saída de exclusão isolada não comprova toda a limpeza. O recibo deve ser preservado sem tokens ou verificadores de autenticação.

## Limitações e próximos aceites

- A publicação desta etapa e a importação dos perfis reais têm verificação própria, posterior. Não inferir produção a partir de build, testes ou Worker temporário.
- Ainda não houve tarefa real de IA criando PR no repositório do usuário como parte destas provas. A modalidade atual de credenciais é chave de API da empresa.
- Limites de duração/tokens não são orçamento financeiro. O limite configurável de R$ 1.000/dia solicitado para Nuria, sua fonte de preços e conciliação ainda precisam de implementação e testes.
- Autonomia 24/7, merge/publicação após os controles de cada repositório, Graft e assinaturas oficialmente suportadas têm critérios de aceite no plano. Nenhum desses recursos deve aparecer como ativo por causa desta validação.

## Publicação posterior

O [recibo de produção da versão .4](evidence/2026-10-14-veltram-catalog-production.json) confirma publicação do commit `0cee4508118283d29633300a6159d2ad689442d8` em https://veltram.com, com 100% do tráfego, saúde HTTP 200, hashes dos assets iguais ao build e nenhuma migration pendente. Os 12 perfis autorizados foram importados na Nuria e a exportação comparada campo a campo; nenhum conteúdo privado foi incluído no repositório. Equipe padrão: Chief of Staff, Eng PRODEV e QA PRODEV. Jev ainda sem chave; os próximos escopos e limitações acima permanecem pendentes.
