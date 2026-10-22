# Decisor — o procurador do dono em "Precisa de você"

O Decisor (`server/owner-decisor.ts`) decide os itens de "Precisa de você" em nome do dono. Ele roda
dentro do servidor (não é um bot, não precisa de VM) e responde pela MESMA rota dos botões do painel
(`POST /api/bots/:id/owner-pending/:item/reply`, chamada em processo), então valem as mesmas
conferências: disco, teto de gasto, dedupe, fila da conversa, item substituído.

## Ligar, desligar, ensaiar

- Desligado enquanto `~/.openmausbot/decisor-policy.json` não existir.
- `{"enabled": true}` (ou `{}`) liga com os padrões abaixo; `{"enabled": false}` desliga sem apagar o arquivo.
- `{"mode": "dry-run"}` só registra o que faria (log `[decisor] [dry-run] …` e `decisor-log.jsonl`).
- O arquivo é relido a cada passada (1 min); não precisa reiniciar o app. JSON inválido = nada é decidido.
- `~/.nuria/stop` também segura o Decisor.

## O que ele faz (padrões lenientes)

| Item | O Decisor |
| --- | --- |
| Tem decisão RECOMENDADA | escolhe a recomendada — inclusive "Só você: aprovação ou autorização" |
| Recomendada cai num limite | fica com o dono (nunca troca pela outra opção) |
| Opções sem recomendada | a mais conservadora que faz andar (neutra > adiar > remover), fora dos limites (`noRecommended`) |
| Sem opções | responde ao bot "pode seguir…" (`noOptionsReply`), o item aguarda o bot |
| Precisa de gesto físico (bot) | devolve ao bot uma vez; se voltar, fecha com nota (`physical`) |
| Precisa de gesto físico (item do servidor: arquivar no app Claude, tomada…) | fecha com nota; se o servidor reabrir em 24 h, fica com o dono |
| Decidido e o bot não deu retorno em 2 h | fecha com nota (`stale`) |
| Conversa de origem apagada / item substituído / "Talvez já resolvido" | fecha com nota |

Nunca decide duas vezes a mesma versão do item; no máximo `maxDecisionsPerItem` (3) por item e
`maxPerTick` (3) por minuto; espera `graceMinutes` (3) depois que o item aparece ou é reescrito.

## Limites que ficam com o dono (hard stops)

1. apagar ou alterar dados de produção (irreversível) — inclusive autorizar QA com escrita em produção
2. comando que destrói dados (DROP, TRUNCATE, DELETE FROM, rm -rf /)
3. gastar dinheiro de verdade
4. mandar mensagem para gente de fora (cliente, e-mail, WhatsApp, redes)
5. expor ou mexer em senha, token ou credencial
6. desligar ou contornar um controle de segurança (hook, revisor, 2FA, --no-verify, --admin, sudo)

Os padrões são regex (sem acento, minúsculas) sobre o título + a decisão escolhida (ou título + passos,
quando não há opções).

## Apertar depois

```json
{
  "enabled": true,
  "mode": "on",
  "noRecommended": "keep",
  "physical": "keep",
  "skipBots": ["<id do bot>"],
  "extraHardStops": [
    { "id": "deploy", "label": "deploy ou release de produção", "anyOf": ["\\bdeploy", "\\brelease\\b", "\\bmerge"] }
  ]
}
```

`hardStops` (em vez de `extraHardStops`) substitui a lista inteira.

## Onde ver

- `~/Library/Logs/openmausbot/server.log`: linhas `[decisor] …`
- `~/.openmausbot/decisor-log.jsonl`: uma linha por decisão (item, opção, motivo, status)
- No item: o histórico marca `decisor: true`; o bot lê `[Decidido pelo Decisor do OpenMausBot, em nome do dono …]`;
  itens fechados ficam na auditoria com `resolvedNote` começando por `Decisor:`.
