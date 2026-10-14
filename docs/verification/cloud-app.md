# Veltram: empresas, credenciais e prova Linux

Esta receita verifica `cloudflare/app`, não o servidor desktop. Usa workerd, D1 e Durable Objects locais, dados descartáveis e e-mail simulado. Nenhuma configuração do OpenMausBot local é importada. `veltram.com` foi registrado em 14/10/2026; o aplicativo não foi publicado.

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

A rodada consolidada aprovou 91 testes: 53 unitários e 38 de integração. `pnpm --filter @openmausbot/cloud-app check`, build da interface, dry-run do Worker, oxlint com avisos tratados como erro e `git diff --check` também passaram. O responsável pela integração confirmou saída zero na sessão de verificação 59226. Essa evidência é local e não comprova publicação ou execução remota.

A aceitação local nativa com Wrangler/Docker comprovou execução, recibo sem nova execução, cancelamento e prazo. No navegador da fixture foram observados login, criação da empresa A, prova concluída com artefato exato, cadastro de chave sintética em A e ausência dessa chave ao criar/trocar para B. Isso ainda não comprova todos os passos do percurso de navegador acima, nem a operação publicada. Registrar separadamente qualquer verificação adicional.

## Preparação remota e limites da prova

A auditoria somente leitura confirmou acesso OAuth aos serviços necessários, nenhum Container configurado na conta e nenhum remetente Email Sending para `veltram.com`. Workers Paid foi confirmado como plano atual no dashboard em 14/10/2026. Nenhum recurso remoto do Veltram foi criado até este registro e nenhum e-mail real foi enviado. Preparar recursos exclusivos, migrações, segredos reais, origem HTTPS, domínio do Worker e domínio remetente antes de publicar; não reutilizar a configuração da fixture.

Containers e envio para destinatários arbitrários exigem Workers Paid, já ativo nesta conta; não é necessária nova contratação. O mínimo divulgado é US$5/mês por conta; e-mail inclui 3.000 envios/mês por conta e cobra US$0,35/1.000 excedentes. Franquias e consumo são compartilhados com outros projetos, portanto não presumir custo incremental zero nem tratar os limites de execução como teto financeiro. A auditoria não contratou plano nem executou prova paga. [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/platform/pricing/).

Não foram verificados entrega real de e-mail, validade de chave no provedor, modelos/agentes de IA, R2, recuperação de backup, migração do app existente ou publicação. A prova Linux executa um programa fixo, não um agente de IA. Guardar saída terminal, respostas, versão e URL de cada ambiente: testes locais, domínio registrado e dry-run não comprovam tarefa concluída na nuvem.
