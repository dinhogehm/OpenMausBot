# Veltram — missões contínuas, orçamento, Graft e assinaturas

## Escopo autorizado

O usuário quer operação inteiramente Cloudflare para múltiplas empresas, agentes com autonomia 24/7 e merge/publicação após os controles de cada repositório. Cada empresa fornece suas próprias credenciais. O limite diário inicial da Nuria é R$ 1.000, configurável por administrador. O usuário pediu Graft para economizar contexto e conexão de assinaturas Anthropic/OpenAI.

## Desenho

- Orçamento central por empresa, dia em America/Sao_Paulo, valores inteiros e reservas atômicas anteriores ao envio. Consumo confirmado/calculado, reservas e resultados incertos são distintos. Custo desconhecido não libera saldo. O teto cobre inferência de API estimada em reais. Assinaturas, uso extra nativo, infraestrutura, impostos e câmbio da fatura não estão incluídos; isso deve ficar explícito na interface e antes da ativação da assinatura.
- Fontes de preço e câmbio versionadas com procedência. Primeiro adaptador financeiro OpenRouter, sem mudar automaticamente a conexão escolhida. O modo de cobrança de cada credencial precisa ser qualificado; a ausência de custo upstream no recibo não prova ausência de BYOK aninhado. Sem essa qualificação, chamadas pagas permanecem bloqueadas. Modelos sem custo máximo verificável ficam indisponíveis para operação autônoma paga.
- Graft estrutural fixado em versão revisada, sem modelo adicional ou rede durante análise, com índice por execução fora do checkout. Ferramentas de mapa, busca, assinatura e referências têm saída limitada e preservam leitura simples como alternativa.
- Conexões por assinatura são individuais por empresa+usuário. Claude Code original em ambiente confiável separado do repositório executa autenticação e inferência; não se extrai OAuth para o broker. Snapshot opaco nativo pode preservar ambiente, sujeito às limitações documentadas. Desconectar impede restauração de gerações anteriores. Perda/estado incerto exige novo login.
- ChatGPT plan usage em aplicativo pago/remoto depende de habilitação OpenAI; não reutilizar registro de aplicativo local nem mostrar integração ativa antes da aprovação. API paga permanece escolha explícita, sem fallback silencioso.
- Missão persistente guarda objetivo, critérios de aceite, política, fila declarada pelo administrador, tentativas e evidência. Esta fase não inclui um planner pago que invente ou decomponha objetivos continuamente. Reinícios reconciliam efeitos incertos antes de nova execução. PR, merge, publicação e aceite têm estados separados.

## Dependências externas

As regras Anthropic exigem Claude Code original e termos comerciais aplicáveis para o serviço hospedar o programa. O usuário precisa realizar seu próprio login/consentimento. A conexão não amplia a franquia da assinatura. OpenAI exige processo específico para aplicativo hospedado. Não há aprovação presumida.

O corredor canônico de produção da Nuria ainda depende do executor local. Integrar publicação completamente cloud exige adaptação autorizada desse projeto preservando seus gates; não executar ou substituir esse corredor nesta implementação do Veltram. Sem adaptador qualificado, a missão fica aguardando publicação e não declara produção.

## Verificação e entrega

Worktree nova a partir do commit 0cee4508118283d29633300a6159d2ad689442d8, após fetch. Testes sintéticos cobrem isolamento, concorrência no último saldo, cancelamento com cobrança tardia, virada de dia, replays e resultados desconhecidos. Provas nativas usam recursos temporários e nenhum repositório real do usuário. Login real por assinatura depende de participação do titular; não copiar credenciais locais.

Publicar somente partes integradas e verificadas. Acompanhar separadamente implementado, ativo e comprovado. Não transformar uma tela ou um teste simulado em afirmação de funcionamento 24/7.
