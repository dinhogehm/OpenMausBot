# Veltram: revisão de interface e comportamento — 15/10/2026

Esta rodada evolui navegação, hierarquia, responsividade, estados e proteção das operações. A revisão usa implementadores por área, inspetores independentes e correções sucessivas. Não é certificação WCAG AAA nem prova de autonomia 24/7. O [plano](../plans/2026-10-15-veltram-quality.md) registra a direção e os responsáveis.

## Evidência isolada

Todos os testes de mutação usaram fixtures locais, contas e dados sintéticos. Nenhuma chave real, chamada paga de IA, modificação de repositório conectado ou operação na empresa Nuria foi feita para testar a interface.

| Área | Mudança e revisão |
| --- | --- |
| Navegação e acesso | URLs por seção/empresa, menu móvel e conta acessíveis, foco e proteção de rascunhos. Inspetor comprovou Escape, descarte explícito e múltiplos Voltar/Avançar durante o mesmo diálogo. |
| Kanban | Filtros móveis recolhíveis, etapas acessíveis, estados vazio/erro, confirmações e travas durante pedidos. Inspeção independente em 1280, 390 e 320 px. |
| Histórico de tarefas | Lista todas as tarefas não terminadas mais as 100 terminadas mais recentes, separadas por workspace. Migração incremental e retomável do índice, com gravações atômicas. 29 testes de CodingRoom aprovados. |
| Conexões e orçamento | Disponibilidade e bloqueios explícitos, edição com proteção de rascunho e operação pendente. Retry, salvar/desfazer orçamento e manter/desconectar assinatura sintética comprovados. Foco após salvar corrigido na rodada final. |
| Relatórios | Lacuna não vira zero, períodos comparáveis identificados, eixos legíveis, exportação inválida recusada, filtros preservam edição. Revisão independente dos gráficos móveis. |
| Agentes/equipe/Jev | Rascunhos por perfil, limites de conteúdo e estado de integração honestos. Busca sem acentos corrigida por achado independente e comprovada na interface. |
| Marketplace | Busca por categoria localizada, filtros e referências distinguem itens instaláveis. Inspetor comprovou instalação sintética, prevenção de repetição, Escape/Fechar e filtro Instalados. Retry e erro de instalação receberam correção de foco; versão completa foi recolhida na procedência. |
| Missões | Consequências de pausar/cancelar explícitas, editor protegido, seleção móvel e publicação pendente distinta de PR. Revisão independente dos estados e tamanhos. |
| Navegador | Ações concorrentes bloqueadas, captura com recuperação, domínios legíveis e resultado terminal honesto. A revisão cruzada identificou CSP incompatível com imagens blob; correção restrita a img-src. |
| Repositórios | Conexão ativa/revogada, erros sem apagar estado conhecido, confirmação de escopo e permissão conservadora. Revisão independente de estados owner/member, erro e confirmação. |
| Empresa e teste de execução | Loading/erro/vazio distintos, prova sintética identificada, criação e ação de detalhe mutuamente bloqueadas. Inspetor conferiu seleção do resultado e tamanhos móveis. |

Tokens compartilhados medidos: texto/canvas 15,25:1; texto secundário/sidebar 7,12:1; texto discreto/surface 7,14:1; destaque/accent-soft 7,03:1; branco/accent 8,95:1; perigo/danger-soft 7,11:1; alerta/warning-soft 7,24:1. Essas medições não certificam cada combinação de estado ou conteúdo. Controles compartilhados têm alvo mínimo de 44 px e campos móveis usam 16 px.

A revisão transversal encontrou seis falhas de rascunho, concorrência e histórico, corrigidas e reavaliadas. A rodada final identificou a política de imagens de produção; os testes primeiro falharam sem `blob:` e passaram após a correção, preservando as fontes restritas de scripts e rede. Não restou P1/P2 confirmado na última revisão de código.

## Verificações automatizadas

- 145/145 testes unitários na rodada final.
- 225/225 testes de integração em 28 arquivos antes da correção isolada da CSP.
- 2/2 testes adicionais GET/HEAD da política de assets após a correção; 227 casos de integração aprovados no conjunto das duas execuções, sem alegar uma nova execução completa de 227 casos.
- Tipos do Worker e da interface, lint do pacote e diff-check aprovados.
- Build final da interface: `index-Pf5iCzmU.js` e `index-CUqmqoCJ.css`.
- Dry-run explícito de `wrangler.production.jsonc` aprovado, preservando as imagens de execução existentes e os bloqueios de produto.
- Hooks de push e evidência de publicação são registrados separadamente no recibo da entrega; dry-run não publica.

## Publicação comprovada

Publicada `veltram-2026-10-15.2`, runtime `f4892e32b84206c77bb24d2284bb4c101e4fe6fc`, Cloudflare `1d76927c-6c61-4dec-ba14-01739399f941`, com 100% do tráfego em 15/10/2026 às 04:45:43 UTC. Saúde, HTML, hashes de JS/CSS e CSP públicos foram conferidos às 04:46:39 UTC. Hooks obrigatórios de lint, tipos e catálogo de idiomas passaram. O [recibo](evidence/2026-10-15-veltram-quality-production.json) vincula versão, commit, assets e limitações; o [PR #22](https://github.com/dinhogehm/OpenMausBot/pull/22) permanece em rascunho para a revisão interativa pendente. A sessão autenticada de produção não foi reinspecionada devido ao bloqueio descrito abaixo.

## Cobertura visual e pendências

As inspeções independentes cobriram desktop e 390/320 px, com estados de erro, vazio e acesso reduzido quando aplicáveis. As [capturas selecionadas](evidence/2026-10-15-veltram-quality/) são de fixtures, não da empresa real. Os detalhes de foco modificados ao final não são comprovados por capturas anteriores.

O Chrome interrompeu parte da rodada funcional com: “Google Chrome is blocking automation because another extension UI is open on this page. Complete or dismiss that extension UI in Google Chrome, then ask me to continue.” Foi solicitada a liberação manual; não houve tentativa de contornar a restrição.

Ficam pendentes de repetição independente após a liberação:

- Foco após salvar orçamento e após retry/falha de instalação do marketplace, nas correções finais.
- Salvar/remover chave, código de assinatura e proteção durante gravação de credenciais.
- Retorno de foco de Alterar e-mail e diálogo global durante solicitação pendente.
- Fluxos completos de criar/aprovar/cancelar no Kanban, navegador e prova de execução; edição/salvamento de perfis, equipe e Jev; confirmações de missões e repositórios; proteção da edição de metas ao trocar filtros de relatório. Há cobertura de código, testes focados e verificações parciais, mas não um aceite funcional independente integral dessas combinações na build final.
- Seleção móvel de Missões e tamanho final do seletor de atraso após os últimos ajustes.

## Limites de produto preservados

`CLAUDE_CODE_ENABLED=false` e `AI_BUDGET_REQUIRED=true`. A prova nativa anterior do Claude manteve 2 casos aprovados e 3 falhos; esta entrega não corrigiu nem requalificou esse isolamento. ChatGPT hospedado aguarda habilitação oficial. APIs pagas seguem pausadas até qualificação de cobrança. O orçamento estimado de API é configurável em BRL; não abrange assinaturas, infraestrutura ou impostos.

Missões persistem tarefas declaradas. Planner autônomo e adaptador qualificado de merge/publicação por projeto continuam pendentes. O fluxo canônico de produção Nuria permanece no executor local. Publicar esta revisão de qualidade não comprova uma tarefa paga real, conexão real de assinatura ou operação autônoma contínua.
