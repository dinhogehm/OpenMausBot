# GitHub App do Veltram: configuração do operador

Este procedimento prepara uma GitHub App pública da plataforma e a instala somente nos repositórios escolhidos. A primeira conexão solicitada é `dinhogehm/nuria-platform`. Não copia o token pessoal do `gh` para o SaaS e não dá ao ambiente de execução tokens do GitHub ou chaves dos modelos.

## O que será autorizado

- A conta `dinhogehm` será dona da GitHub App, salvo escolha explícita de uma organização proprietária.
- Permissões: **Contents: read/write**, **Pull requests: read/write** e **Metadata: read** implícito. Sem administração de repositórios, Actions, Workflows, segredos ou merge automático.
- A instalação deve usar **Only select repositories**, inicialmente `dinhogehm/nuria-platform`.
- A App poderá criar branches `veltram/<runId>` e PRs em rascunho nesse repositório. O serviço só publica conteúdo cujo recibo corresponde aos arquivos testados. Não atualiza branches existentes.
- A criação da App, instalação e gravação de secrets na Cloudflare precisam estar expressamente aprovadas antes de executar o modo de configuração. A prévia abaixo não modifica serviços externos.

## Prévia sem alterações remotas

Na pasta `cloudflare/app`:

```sh
node scripts/github-app-setup.mjs --owner dinhogehm
```

O comando imprime uma URL de registro com os campos públicos preenchidos. Pode ser revisada no GitHub sem clicar em **Create GitHub App**. O script não abre servidor, chama APIs ou escreve arquivos nesse modo.

Os endpoints de produção são:

| Finalidade | URL |
| --- | --- |
| Homepage | `https://veltram.com` |
| Callback OAuth | `https://veltram.com/api/github/callback` |
| Após instalação | `https://veltram.com/api/github/setup` |
| Webhook | `https://veltram.com/api/github/webhook` |

Deixar **Request user authorization during installation** desmarcado. O Veltram inicia a autorização com estado descartável ligado à sessão/empresa e PKCE S256. Não habilitar wildcard no callback. Assinar os eventos `pull_request` e `repository`; eventos de instalação e alterações de repositórios chegam automaticamente.

## Manifesto com recepção local única

Depois da aprovação, com a autenticação do Wrangler e o Worker de destino previamente verificados:

```sh
node scripts/github-app-setup.mjs --serve --approved --owner dinhogehm --worker veltram --config wrangler.production.jsonc
```

Para uma organização proprietária, adicionar `--organization` e informar o login dela em `--owner`.

1. Abrir a URL local impressa. O servidor aceita apenas `127.0.0.1`, valida o Host e expira em 55 minutos.
2. Revisar conta proprietária, Worker e manifesto. O botão abre o registro no GitHub; o operador confirma a criação na página do GitHub.
3. O GitHub volta ao endereço local com estado e código de conversão. O servidor valida o estado uma única vez e converte o código sem registrar seu valor.
4. Chave privada, client secret e webhook secret ficam apenas na memória e são enviados pelo stdin ao `wrangler secret bulk`. A saída do Wrangler é descartada para evitar exposição acidental. Nenhum arquivo de secrets é criado pelo script.
5. Também são gravados `GITHUB_APP_ID`, `GITHUB_APP_SLUG` e `GITHUB_CLIENT_ID`. Esses identificadores são públicos; o script imprime um objeto que pode posteriormente ser movido para `vars`, sem alterar os valores.
6. Se a gravação não for confirmada, o processo mantém os mesmos valores em memória e oferece repetição explícita. Não criar outra App. Se o processo morrer após a conversão, recuperar a App existente pelo procedimento manual abaixo.
7. Após publicar a versão do Worker que contém as rotas GitHub, fazer a instalação nos repositórios escolhidos e conectar a empresa no Veltram.

A documentação do manifesto define `redirect_url` como URL completa e separa esse redirecionamento do callback OAuth de produção. O tutorial oficial de OAuth demonstra callbacks HTTP locais. O recebimento local de manifesto está coberto por fixture automatizada; sua aceitação no registro real do GitHub só fica comprovada durante a confirmação do operador. Se o GitHub recusar o redirecionamento local, usar o registro manual pré-configurado, sem abrir túneis públicos ou relaxar a validação de estado.

## Alternativa manual e recuperação

Usar a URL da prévia e criar ou editar a App na conta correta. Na App existente, gerar uma chave privada e um client secret; configurar um webhook secret aleatório. Inserir cada valor pelo prompt confidencial do Wrangler, nunca em argumentos de linha de comando, mensagens de chat ou logs:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --name veltram --config wrangler.production.jsonc
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET --name veltram --config wrangler.production.jsonc
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY --name veltram --config wrangler.production.jsonc
pnpm exec wrangler secret put GITHUB_APP_ID --name veltram --config wrangler.production.jsonc
pnpm exec wrangler secret put GITHUB_APP_SLUG --name veltram --config wrangler.production.jsonc
pnpm exec wrangler secret put GITHUB_CLIENT_ID --name veltram --config wrangler.production.jsonc
```

Para a chave PEM multilinha, o operador pode redirecionar o arquivo que o próprio GitHub baixou para o stdin do comando de secret, em vez de colá-lo no chat. Manter o arquivo fora do repositório e removê-lo com cuidado depois de confirmar o armazenamento. Nunca usar uma chave pessoal do GitHub ou um token do `gh` como substituto.

## Verificação sem alterar dados de produção

Antes de publicar, rodar as fixtures locais:

```sh
node --test scripts/github-app-setup.test.mjs
pnpm exec vitest run test/github.integration.test.ts test/github-broker.integration.test.ts
```

As fixtures usam credenciais sintéticas, APIs GitHub simuladas e D1 isolado. Cobrem estado OAuth, sessão/empresa, expiração, cifra, propriedade da conta, disputa entre empresas, revogação assinada, download com SHA fixado, limite do arquivo, cancelamento, recibo dos testes e reconciliação de PR após resposta perdida.

Após a instalação autorizada, confirmar por leitura que a conexão mostra exatamente `dinhogehm/nuria-platform`. Executar a primeira tarefa real somente com escopo e comandos definidos pelo usuário. Evidência de sucesso precisa ligar tarefa, SHA inicial, arquivos testados, resultado do teste e URL do PR. A presença de credenciais ou de uma instalação não comprova execução de agentes.

## Fontes oficiais

- [Registro por manifesto](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Registro por parâmetros de URL](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters)
- [Callback local no tutorial GitHub](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app)
- [OAuth, estado e PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Alerta sobre installation_id forjado](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Tokens de instalação restritos](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Validação de webhooks](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
