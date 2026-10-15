# Veltram: revisão integral de qualidade

## Direção

O usuário autorizou revisão e melhoria completa, com subagentes por item e inspeção visual independente. A identidade existente (verde mineral, superfícies claras, português direto) é o ponto de partida. Entre refazer a marca, apenas ajustar detalhes ou reconstruir a experiência sobre a identidade existente, escolhemos a terceira opção: corrigir navegação, hierarquia e fluxos, depois acabamento. A cena continua sendo trabalho prolongado em escritório iluminado.

Não existe comando `/loop` instalado nesta sessão. O processo equivalente será explícito por item: analisar → corrigir → verificar → revisão visual independente → corrigir achados e repetir. Aprovação depende de evidências, não de entusiasmo subjetivo. Nenhuma alegação de perfeição absoluta ou certificação WCAG sem avaliação correspondente.

## Itens e responsabilidade

1. Estrutura, navegação, acesso e onboarding: root; aaa_shell_inspector.
2. Tarefas/Kanban: aaa_kanban_audit; aaa_kanban_inspector.
3. Conexões de IA e orçamento: aaa_connections_audit; aaa_connections_inspector.
4. Relatórios: aaa_reports; inspeção visual independente delegada pelo implementador.
5. Missões: aaa_missions; aaa_missions_inspector.
6. Agentes/equipe/Jev: aaa_agents; aaa_agents_inspector.
7. Marketplace: aaa_marketplace; aaa_marketplace_inspector.
8. Repositórios: aaa_repositories; aaa_repositories_inspector.
9. Navegador: aaa_browser; aaa_browser_inspector.
10. Empresa/teste de execução: aaa_company_execution; aaa_company_execution_inspector.
11. Histórico de tarefas: aaa_active_tasks_backend; aaa_cross_code_review, que também revisou os contratos compartilhados.

## Critérios

- Seções endereçáveis, recarregáveis e compatíveis com Voltar/Avançar, sem quebrar seleção/autorização da empresa.
- Conteúdo e ações acessíveis em desktop, tela baixa, tablet e 320/390 px; nenhuma ação essencial oculta sem indicação.
- Navegação por teclado, foco restaurado após fechar painéis, alvos de toque de pelo menos 44px e sem dependência exclusiva de cor.
- Contraste medido; texto auxiliar legível, foco e estados consistentes. Buscar 7:1 para texto normal nos tokens compartilhados sem afirmar conformidade AAA global.
- Estados carregando, vazio, erro, resultado parcial, permissão insuficiente e ação indisponível com recuperação compreensível.
- Nenhum dado sintético em produção, nenhuma métrica inventada e nenhuma promessa de assinatura ou autonomia ainda bloqueada.
- Operações pendentes e resultados incertos não podem ser descartados visualmente ou reenviados como uma nova ação por acidente.
- Verificar funcionalidade em fixtures isoladas. Produção apenas conferência de leitura após publicação autorizada.

## Limites preservados

Claude continua desativado devido ao bloqueio de isolamento; ChatGPT depende de habilitação oficial; APIs pagas dependem de qualificação de cobrança. Esta revisão não pode remover esses controles para aparentar completude. Planner e merge/publicação do repositório Nuria continuam dependências explícitas.

## Entrega

Worktree nova sobre origin/codex/veltram-continuous-llm (83564208e) após fetch. Registrar testes, ciclos de revisão por item, capturas, achados restantes e recibo de publicação. PR empilhado no #21. Build/teste/PR/publicação e operação real são estados distintos.

## Execução da revisão

Todas as áreas receberam implementação e uma revisão independente. A rodada transversal encontrou seis falhas de proteção de rascunhos, concorrência e histórico; foram corrigidas e reavaliadas. A inspeção visual incluiu desktop, 390 px e 320 px, além de estados vazio, erro, indisponível e permissões reduzidas em fixtures descartáveis.

Foram aprovados 145 testes unitários e 225 testes de integração antes dos últimos ajustes de foco. A rodada funcional adicional confirmou rascunhos e múltiplos Voltar/Avançar, instalação única de pacotes, referências sem instalação, busca localizada, recuperação de orçamento e desconexão sintética de assinatura. Encontrou perdas de foco após recuperar detalhe, falhar instalação e salvar orçamento, corrigidas em seguida.

Uma interface de extensão aberta no Chrome bloqueou parte da inspeção. Foi solicitada a liberação manual ao usuário; os casos ainda não repetidos devem permanecer marcados como pendentes. O relatório de verificação da rodada registra a cobertura e suas limitações. Nenhuma mutação de teste foi realizada na empresa real.

Publicada a versão `veltram-2026-10-15.2` a partir de `f4892e32b84206c77bb24d2284bb4c101e4fe6fc`, com 100% do tráfego. Saúde, HTML, hashes e CSP públicos conferidos. O [relatório](../verification/veltram-quality.md) e o [recibo](../verification/evidence/2026-10-15-veltram-quality-production.json) distinguem a publicação comprovada dos testes interativos pendentes. A revisão integral permanece aberta; não foi declarada perfeição ou aprovação funcional completa.
