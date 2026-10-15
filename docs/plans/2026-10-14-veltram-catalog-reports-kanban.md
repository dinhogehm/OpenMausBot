# Veltram: agentes, relatórios, Kanban, navegador e marketplace

O usuário pediu copiar os agentes do OMB local, copiar a tela e as funcionalidades de relatórios sem o histórico local, usar Kanban em Tarefas e incluir Jev.

Durante a execução, confirmou manter Jev como serviço, disponibilizar CUA de navegador na Cloudflare e reunir os catálogos públicos de equipes/agentes OMB e Grok Bot. Não pediu controle de aplicativos nativos do Mac. A análise do upstream `330b098b7` identificou o núcleo Apache-2.0 e a exceção `enterprise/`; nenhuma implementação dessa pasta será incorporada ao SaaS.

O escopo foi ampliado para autonomia contínua, orçamento financeiro, Graft e conexão de assinaturas de modelos quando houver suporte oficial. Esses itens estão planejados; a implementação atual ainda não opera de forma autônoma 24/7. A validação desta etapa está registrada na [receita de catálogo, relatórios, navegador e marketplace](../verification/veltram-catalog-browser-marketplace.md), separada de qualquer publicação do aplicativo.

## Resultado esperado

- Catálogo privado por empresa, com importação dos 12 perfis locais identificados. Preservar nome, título, descrição, instruções, seção e referências ao modelo original. Não importar credenciais, sessões, permissões locais, conversas ou tarefas antigas. Os perfis podem ser escolhidos para os três papéis da execução e são congelados em cada tarefa. O modelo original do desktop é informativo; a execução usa um modelo configurado da empresa.
- Jev permanece um serviço de decisão. Sua integração recomenda a equipe entre os perfis disponíveis e mostra a escolha antes da aprovação; não concede permissões nem substitui testes ou revisão. Chave própria por empresa, criptografada, endpoint oficial fixo, limite de tempo e resposta validada. Sem chave ou decisão confiável, preservar a seleção explícita.
- Kanban com colunas derivadas da execução real: a aprovar, na fila, em execução, em revisão, concluídas e precisam de atenção. Busca e filtros de repositório/agente, detalhes por cartão e criação de tarefa em diálogo. Nenhum movimento visual pode declarar execução ou testes concluídos.
- Relatórios com períodos e comparações, gráficos acessíveis, tarefas/PRs/testes, atividade por agente, metas e exportações Markdown/PDF. Fatos estruturados por empresa sustentam os números. Tokens reservados não são consumo confirmado; atualização de estado não é duração. Fontes ainda não acompanhadas aparecem como desconhecidas, especialmente produção/DORA/custo faturado. A coleta nova não importa histórico local.
- Navegador Cloudflare Browser Run, com aprovação da tarefa, modelo BYOK com visão, domínio permitido, limite de tempo/ações/tokens, capturas autenticadas e cancelamento. Isolamento de sessão e dados por empresa; sem importar cookies ou sessões locais. A primeira versão não inclui transferência interativa de login. Prova remota em site sintético próprio, sem uso de modelo pago nem ação em dados do usuário.
- Marketplace com snapshot versionado das seis equipes MIT da comunidade OMB (18 perfis) e 90 referências públicas Grok Bot. Mostrar origem, licença, conteúdo incluído e dependências. Instalar somente perfis OMB; não executar plugins, ativar rotinas ou conectar serviços. Referências Grok não têm instruções redistribuídas nem botão de instalação sem licença. Instalação idempotente, administrativa e sem sobrescrever personalizações.

## Próximo escopo autorizado — ainda não implementado

- Operação autônoma 24/7: manter objetivos e fila duráveis, retomar trabalho elegível e acompanhar resultados sem depender do Mac ligado. Definir quais ações cada empresa autoriza, com pausa, cancelamento e tratamento de falhas observáveis. Uma continuação não deve repetir efeitos cujo resultado seja desconhecido.
- Merge e publicação: permitir que o trabalho avance depois dos testes, revisões e controles exigidos pelo repositório. Descobrir e respeitar instruções, proteção de branches, concorrência e processo oficial de release de cada projeto. Para Nuria, preservar o caminho PR para `main` e o executor canônico de publicação definido pelo projeto; a disponibilidade de um agente na nuvem não substitui esses controles. Guardar evidências separadas de PR, merge, publicação e verificação do ambiente.
- Orçamento financeiro: limite diário configurável por empresa, com valor inicial solicitado de **R$ 1.000 por dia para Nuria**. Implementar fonte de preços, conversão de moeda com procedência, reserva antes do gasto, conciliação do uso observado e bloqueio durável ao atingir o limite. Definir os serviços incluídos e a janela diária antes de ativá-lo. Os limites atuais de tokens, chamadas e duração não implementam esse teto em reais; custo sem fonte permanece não acompanhado.
- Graft nos agentes: integrar consulta e navegação de código ao fluxo dos agentes, com índice restrito ao repositório/empresa e revisão fixada. Verificar compatibilidade com o executor na nuvem, comportamento quando o índice estiver ausente ou desatualizado, e evidência de utilidade. O uso de Graft durante o desenvolvimento deste projeto não comprova integração no produto.
- Assinaturas de LLM: conectar contas ou assinaturas somente pelos mecanismos oficialmente oferecidos e permitidos pelo provedor para essa modalidade de uso. Pesquisar suporte por provedor, implementar autorização e revogação quando disponíveis e explicar o estado na interface. A modalidade atual é BYOK de API; não há reaproveitamento de login, cookie ou sessão do desktop, nem promessa de que uma assinatura de chat inclua execução por API.

Critérios de aceite dessa próxima etapa: ciclo autônomo comprovado em repositório descartável; reinício/cancelamento sem efeito duplicado; bloqueio do orçamento sob concorrência e uso tardio; merge/publicação somente após os controles do projeto; recibo que ligue tarefa, código testado, PR, release e ambiente. Nenhuma tarefa paga no repositório real do usuário será criada apenas para testar o sistema.

## Implementação e verificação

1. Backend catálogo/Jev, migração, importação permitida por administrador com versão esperada; testes de validação, isolamento, repetição, resposta inválida, tempo e revogação.
2. Ledger e agregação dos relatórios; testar fatos idempotentes, cobertura, calendário de São Paulo, comparações e limites de empresa.
3. Interface de catálogo/Jev/relatórios e Kanban; fixture sintética no desktop e celular, teclado, falhas e troca de empresa.
4. Rodar testes unitários e workerd/D1, tipos, lint, build e dry-run. Revisar mudanças de autorização e recuperação.
5. PR sobre a entrega GitHub/agentes, publicação Cloudflare com migrações e segredos existentes preservados. Verificar versão, tráfego, HTTPS e assets.
6. Importar perfis reais somente após publicação, pelo fluxo autenticado da empresa Nuria; confirmar contagem e campos, sem criar tarefa paga no repositório do usuário para teste.
7. Verificar Browser Run real com o mesmo adaptador de produção, fechamento de sessão e políticas de rede. Testar fronteiras de empresa, reconfiguração de chave, aprovação, cancelamento, interrupção e orçamento com provedores sintéticos.
8. Verificar catálogo marketplace completo no snapshot declarado, instalação/repetição/personalizações e referências externas. Guardar licença MIT e procedência dos pacotes.

## Evidências e pendências de QA desta etapa

- Browser Run remoto: [recibo `9ac4eb946ebb`](../verification/evidence/veltram-browser-proof-9ac4eb946ebb.json) aprovado em site sintético na Cloudflare. HTTP 200, preenchimento/clique observados, JPEG de 17.864 bytes, WebSocket e host externo bloqueados, sessão encerrada e Worker temporário respondendo 404 após remoção. Não usou modelo pago nem dados de produção.
- Interface verificada em fixture via CUA: Kanban, relatórios, exportação Markdown, troca de empresa e criação/aprovação/cancelamento da tarefa de navegador. Capturas da fixture são sintéticas; não comprovam uma execução de IA real.
- Marketplace verificado em fixture via CUA: instalação de uma equipe com quatro perfis uma única vez; repetição desabilitada; outra empresa com papel membro sem permissão de instalação; apresentação legível no celular.
- Catálogo/Jev/relatórios também tiveram verificações isoladas de edição, seleção de equipe, importação de 12 perfis sintéticos com remoção de campos privados, gravação da chave com limpeza do campo, filtros/metas, exportação e isolamento na troca de empresa. Os testes de estado cobrem rejeição de respostas de outro escopo e de atualizações antigas.
- Os testes de relatórios cobrem uso observado depois da virada do dia, PR confirmado depois do cancelamento e cancelamento antes do início sem duração artificial. A revisão do navegador cobre limites, reinício sem repetição, uso antes de falha da ação e continuação tardia sem interferir na execução seguinte.
- A suíte final registrada pelo responsável pela entrega passou 88/88 testes unitários e 149/149 de integração. Antes da entrega, concluir tipos, lint, build e dry-run nos fontes finais. Confirmar teclado, mensagens de falha e impressão/PDF na interface; não há aceite de PDF renderizado registrado nesta etapa.
- Publicação desta nova etapa, migrações correspondentes, conferência dos assets e importação autenticada dos perfis reais continuam dependentes do fluxo de entrega. Este plano e a prova remota isolada não são recibos de produção.

Referências da integração Jev: https://docs.typesafe.ai/introduction/quickstart e https://docs.typesafe.ai/primitives/choice, consultadas em 14/10/2026. API `POST https://api.typesafe.ai/v1/systemone`, modelo `jev-latest`, perguntas com `instructions`/`criteria` e escolhas validadas contra os candidatos.
