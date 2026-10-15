# Veltram: empresas, credenciais e prova Linux

Esta receita verifica `cloudflare/app`, não o servidor desktop. As fixtures locais usam workerd, D1 e Durable Objects locais, dados descartáveis e e-mail simulado. Nenhuma configuração do OpenMausBot local é importada. As evidências abaixo registram a versão inicial `veltram-2026-10-14.2`, separando testes locais, executor remoto isolado e autenticação real autorizada por API. A publicação atual `veltram-2026-10-14.3`, com agentes e conexão GitHub, está documentada na [receita dos agentes](veltram-coding.md#publicação-e-conexão-verificadas).

## Testes automatizados

Na raiz do worktree, com Node 24 e pnpm:

```sh
pnpm --filter @openmausbot/cloud-app test
pnpm --filter @openmausbot/cloud-app check
pnpm --filter @openmausbot/cloud-app dry-run
```

`test` executa os testes puros e abre a fixture workerd/D1. `test/setup.ts` aplica migrações e limpa registros entre casos. O remetente falso captura apenas códigos sintéticos. As requisições passam pelo handler HTTP real do Worker ou da autenticação; os testes de coordenação usam um executor controlado. O plugin encerra a fixture ao concluir. `dry-run` constrói a interface e empacota o Worker, sem publicar.

## Navegador com executor nativo local

Esta fixture exige Docker funcionando para o Container Linux. Execute em um terminal dedicado na raiz do worktree. O diretório temporário precisa ser o mesmo nas migrações e no servidor:

```sh
pnpm --filter @openmausbot/cloud-app build
VELTRAM_FIXTURE_STATE="$(mktemp -d "${TMPDIR:-/tmp}/veltram-browser.XXXXXX")"
pnpm --filter @openmausbot/cloud-app exec wrangler d1 migrations apply DB --local --config test/fixtures/wrangler.browser.jsonc --persist-to "$VELTRAM_FIXTURE_STATE"
pnpm --filter @openmausbot/cloud-app exec wrangler dev --local --config test/fixtures/wrangler.browser.jsonc --persist-to "$VELTRAM_FIXTURE_STATE" --ip 127.0.0.1 --port 8795
```

Abra `http://127.0.0.1:8795`. Use somente endereços sintéticos como `alice@example.test` e `bob@example.test`. Solicite o código pela interface e, depois disso, consulte `GET /__fixture/otp?email=alice%40example.test` no mesmo servidor para obter `{otp}`. Nenhuma mensagem real é enviada: `browser-worker.ts` intercepta o remetente e grava o código exclusivamente no D1 temporário. A rota de código existe somente nesse entrypoint de fixture; nunca publicar sua configuração, seus segredos sintéticos ou o diretório temporário.

Percurso de aceitação:

1. Entrar com código, criar a empresa A e confirmar o workspace inicial.
2. Criar uma prova com texto identificável, aprovar e acompanhar até a conclusão; conferir que o artefato corresponde exatamente ao texto.
3. Recarregar a página e conferir histórico e resultado persistidos. Criar outra prova com atraso, aprovar e cancelar; não aceitar sucesso tardio após o cancelamento.
4. Cadastrar somente uma chave falsa na empresa A. Criar/trocar para a empresa B e conferir ausência da chave, das provas e dos resultados de A. Voltar a A e conferir seus dados.
5. Sair e entrar com outro usuário sintético; conferir que recursos da primeira conta não aparecem. Os testes de API abaixo devem também negar acesso por IDs conhecidos, não apenas esconder elementos na interface.

Ao terminar, use Ctrl-C no terminal que lançou essa fixture. Remova somente o diretório exato guardado em `VELTRAM_FIXTURE_STATE`, depois que seu processo tiver encerrado; nunca interrompa processos por nome ou apague uma raiz temporária inteira. Não usar `--remote`, bindings remotos ou dados reais nesta receita.

## Prova do adaptador Linux

Há duas camadas complementares:

- `test/linux-proof.docker.test.ts` executa o programa fixo em um Container Docker descartável, sem rede, credenciais ou diretório do host montado. Rodar na raiz: `pnpm --filter @openmausbot/cloud-app exec node --experimental-strip-types --test test/linux-proof.docker.test.ts`. Essa prova isolada do programa não substitui a integração nativa de Wrangler.
- `test/fixtures/linux-runtime-wrangler.jsonc` usa o `LinuxExecutor` real e a API nativa do Container via Wrangler/Docker. Lançar com armazenamento temporário exclusivo, `wrangler dev --local --config test/fixtures/linux-runtime-wrangler.jsonc --ip 127.0.0.1 --port 8796 --persist-to <diretorio-temporario-absoluto>`, a partir de `cloudflare/app`. O entrypoint aceita apenas POST locais em `/execute` e `/stop`. O JSON de execução contém `runId`, `organizationId`, `workspaceId`, `generation`, `message`, `delayMs` e `deadlineAt` absoluto. Usar identidades sintéticas distintas por caso e prazo de até 60 segundos.

Na fixture nativa, verificar execução e conteúdo exato; repetição idêntica após conclusão devolvendo o recibo sem novo comando; identidade repetida com payload diferente recusada; parada de execução em andamento; despacho após parada recusado; prazo já vencido e expiração durante espera. Guardar as respostas e confirmar encerramento dos Containers da própria fixture.

## Evidências exigidas

- Login por código, e-mail verificado, cookie HttpOnly e logout efetivo; recusa de código incorreto, usado, expirado ou substituído por reenvio.
- Duas empresas com nomes iguais e usuários diferentes, sem leitura/escrita cruzada; IDs inexistentes e sem acesso produzem a mesma resposta.
- Membro comum não administra chaves nem aprova provas; revogação da associação vale na próxima requisição, antes de gravar uma chave e antes do despacho aprovado.
- Banco contém ciphertext, não a chave original; resposta contém metadados. AAD incorreto e adulteração impedem descriptografia.
- Duas substituições concorrentes: somente uma aceita a versão anterior. Revogação limpa ciphertext e registra auditoria na mesma transação.
- Origem estranha, corpo excessivo, provedor inválido e chave mestra indisponível falham sem refletir material sensível. Limites por IP, destinatário e empresa são respeitados; revogação permanece disponível com cota cheia. E-mails inválidos não geram registros.
- Criação de prova idempotente, aprovação persistida antes do despacho, isolamento por empresa/workspace e geração; nenhuma rota pública aceita callbacks do executor.
- Uma execução por empresa, quatro no conjunto, 30 admissões por hora no conjunto e 100 provas totais por empresa. O limite de histórico não promete descarte automático.
- Prazo absoluto de 60 segundos desde a aprovação e limite do executor de 45 segundos, sujeito ao prazo menor; atraso não renova a concessão. Saída e artefato limitados e conteúdo exato para sucesso.
- Cancelamento e expiração invalidam a geração antiga. A vaga só é liberada após confirmação de parada, inclusive ao reavaliar concessões expiradas; falha na parada conserva a vaga.
- Recuperação depois de despacho incerto produz interrupção, sem repetir o comando. Recibo concluído pode ser reutilizado sem execução. O executor recebe somente o programa fixo e seus dados, sem chaves de IA e sem rede externa.

## Resultado local em 14/10/2026

A rodada final aprovou 92 testes: 53 unitários e 39 de integração. `pnpm --filter @openmausbot/cloud-app check`, build da interface, dry-run com `wrangler.production.jsonc`, oxlint com avisos tratados como erro e `git diff --check` também passaram. O responsável pela integração confirmou saída zero na sessão de verificação 61968. A rodada inclui a regressão de classificação do cancelamento encontrada na prova remota.

A aceitação local nativa com Wrangler/Docker comprovou execução, recibo sem nova execução, cancelamento e prazo. No navegador da fixture foram observados login, criação da empresa A, prova concluída com artefato exato, cadastro de chave sintética em A e ausência dessa chave ao criar/trocar para B, além de cancelamento, logout e apresentação em largura de 390 px. Essas observações locais não substituem a navegação completa no ambiente publicado.

## Publicação atual em 14/10/2026

O segundo deploy com `wrangler.production.jsonc` terminou com saída zero e inclui a correção de classificação do cancelamento. Identificadores da versão atual:

| Evidência | Valor |
| --- | --- |
| Código | Commit `42b962a5fbacecd75b7369c96b789e764c31d0d9` |
| Release | `veltram-2026-10-14.2` |
| Versão Cloudflare | `902dd974-dd94-4477-ac60-edc5567b0877` |
| Dashboard | Mesma versão ativa, Ready e com 100% do tráfego |
| URL | `https://veltram.com` |
| D1 exclusivo | `8d86866b-bf87-4c2f-afcc-f8324fbea0ae`; duas migrações aplicadas |
| Segredos | `AUTH_SECRET` e `CREDENTIAL_MASTER_KEY` novos e exclusivos, instalados sem registrar valores |
| E-mail | Email Sending habilitado; SPF, DKIM, DMARC e MX confirmados por DNS; solicitante confirmou recebimento real do OTP |
| Saúde | HTTPS 200: `{service: "veltram", status: "ok", release: "veltram-2026-10-14.2"}` |
| Autenticação | Login autorizado por API: 200 e sucesso; sessão autenticada; cookie Secure e HttpOnly |
| Logout | 200, seguido de `/api/session` com 401 |
| JavaScript | `index-CWljiH3O.js`, SHA-256 `2086c2c317bf2867965b255b7b57f6554160af95b1e1aa0f333196bb957d8158`, idêntico ao build local |

O DNS autoritativo e os resolvedores 1.1.1.1 e 8.8.8.8 retornaram `104.21.44.75` e `172.67.197.74`. O resolvedor local do Mac ainda retornava NODATA em cache. Por isso, as verificações HTTPS acima fixaram a resolução ao IP autoritativo, mantendo validação TLS para `veltram.com`; elas comprovam a resposta do destino, não a resolução normal naquele host. Revalidar navegação normal após a atualização do cache, sem prometer um horário exato.

O primeiro acesso real foi autorizado pelo solicitante após confirmar o recebimento do código. Login, consulta da sessão e logout foram feitos por HTTPS com a mesma resolução explícita e TLS válido. Nenhum endereço pessoal, código, valor de cookie ou identificador de sessão é registrado nesta documentação. Isso comprova autenticação pela API; não é prova da navegação completa em produção.

## Executor remoto isolado

O [recibo de execução e limpeza](evidence/2026-10-14-veltram-linux.json) contém o resultado inicial e a prova corrigida. A fixture respondeu 200, saída zero e artefato de 81 bytes exatamente correto; a repetição devolveu o recibo em 159 ms. A primeira execução de cancelamento parou o Container, mas classificou a resposta como `executor_failed`; essa asserção vermelha motivou a correção e o teste de regressão.

Após a correção, `stop` respondeu 200 em 313 ms, a execução interrompida respondeu 409 com `executor_stopped` em 2.286 ms e uma chamada tardia foi recusada com 409 em 150 ms. O SHA-256 do executor verificado, `98cb89504beb75bb7c2d02cc76f3371c7bf680cb1e7f4bd482758a28996b9086`, corresponde ao código publicado. A fixture, sua aplicação de Container e seu segredo temporário foram removidos; havia zero instâncias antes da remoção e o endpoint removido respondeu 404. Essa prova isolada não substitui o fluxo completo de execução pela interface autenticada do aplicativo.

## Publicações seguintes

Usar explicitamente a configuração de produção, após testes e atualização revisada do identificador de release:

```sh
pnpm --filter @openmausbot/cloud-app build
pnpm --filter @openmausbot/cloud-app exec wrangler deploy --dry-run --config wrangler.production.jsonc
pnpm --filter @openmausbot/cloud-app exec wrangler deploy --config wrangler.production.jsonc
```

Somente quando existirem migrações novas revisadas, aplicar com `pnpm --filter @openmausbot/cloud-app exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`. Não publicar os entrypoints de fixture nem regenerar segredos como rotina. Trocar a chave mestra sem recriptografar dados impede a leitura das credenciais; rotação exige procedimento próprio. Registrar a nova versão e repetir saúde, identidade do asset e provas funcionais pertinentes.

## Limites e pendências

Workers Paid foi confirmado como plano atual no dashboard; não houve nova contratação. O mínimo divulgado é US$5/mês por conta; e-mail inclui 3.000 envios/mês por conta e cobra US$0,35/1.000 excedentes. Franquias e consumo são compartilhados com outros projetos. Publicação e fixture remota consomem recursos da conta; a fatura incremental não foi aferida e os limites de execução não são teto financeiro. [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/platform/pricing/).

Permanecem sem prova a navegação e o fluxo multiempresa completo em produção, condicionados à nova conferência após atualizar o cache DNS local, além de validade de chave no provedor, modelos/agentes de IA, R2, recuperação de backup e migração do app existente. A prova Linux executa um programa fixo, não um agente de IA. Guardar saída terminal, respostas, versão e URL de cada ambiente: deploy, autenticação por API, saúde e assets corretos não comprovam todos os fluxos publicados.
