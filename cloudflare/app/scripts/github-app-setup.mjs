#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://veltram.com";
const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
const equal = (left, right) => {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function buildManifest(redirectUrl) {
  return {
    name: "Veltram", url: origin, description: "Geração de código e testes em ambientes isolados na Cloudflare, com entrega por pull request.", public: true,
    redirect_url: redirectUrl, callback_urls: [origin + "/api/github/callback"], setup_url: origin + "/api/github/setup",
    setup_on_update: true, request_oauth_on_install: false,
    hook_attributes: { url: origin + "/api/github/webhook", active: true },
    default_permissions: { contents: "write", pull_requests: "write" }, default_events: ["pull_request", "repository"],
  };
}
export function registrationUrl(owner, organization = false) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new Error("Invalid owner");
  const url = new URL(organization ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new");
  const manifest = buildManifest("http://127.0.0.1/callback");
  url.search = new URLSearchParams({ name: manifest.name, url: origin, description: manifest.description, public: "true",
    "callback_urls[]": manifest.callback_urls[0], setup_url: manifest.setup_url, setup_on_update: "true", request_oauth_on_install: "false",
    webhook_active: "true", webhook_url: manifest.hook_attributes.url, contents: "write", pull_requests: "write" }).toString();
  url.searchParams.append("events[]", "pull_request"); url.searchParams.append("events[]", "repository");
  return url.href;
}
function page(title, content) {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}
async function responseJsonBounded(response) {
  if (!response.ok || !response.body) throw new Error("GitHub manifest conversion failed");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) { await reader.cancel(); throw new Error("Response too large"); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
function validateCredentials(value, owner) {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || value.owner?.login?.toLowerCase() !== owner.toLowerCase()
    || typeof value.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(value.slug)
    || typeof value.client_id !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.client_id)
    || typeof value.client_secret !== "string" || value.client_secret.length < 16 || value.client_secret.length > 500
    || typeof value.webhook_secret !== "string" || value.webhook_secret.length < 16 || value.webhook_secret.length > 500
    || typeof value.pem !== "string" || value.pem.length > 16_384 || !/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(value.pem)) throw new Error("GitHub manifest response invalid");
  return { GITHUB_APP_ID: String(value.id), GITHUB_APP_SLUG: value.slug, GITHUB_CLIENT_ID: value.client_id,
    GITHUB_CLIENT_SECRET: value.client_secret, GITHUB_PRIVATE_KEY: value.pem, GITHUB_WEBHOOK_SECRET: value.webhook_secret };
}

/** Only stdin receives the values; Wrangler output is drained without being logged. */
export async function uploadSecrets(secrets, { worker, config }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) throw new Error("Invalid Worker name");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", worker, "--config", config], {
      cwd: appDirectory, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_LOG: "error", WRANGLER_SEND_METRICS: "false" },
    });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Secret upload confirmation timed out")); }, 60_000);
    child.stdout.resume(); child.stderr.resume(); child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("Secret upload could not start")); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error("Secret upload was not confirmed")); });
    child.stdin.end(JSON.stringify(secrets));
  });
}

/** Starts only a loopback server. GitHub/Cloudflare writes happen after the human creates the App. */
export async function startSetupServer({ owner, organization = false, worker, config, lifetimeMs = 55 * 60_000 }, services = {}) {
  registrationUrl(owner, organization);
  if (!worker || !config) throw new Error("Worker and config are required");
  const request = services.fetch ?? fetch, storeSecrets = services.uploadSecrets ?? uploadSecrets;
  const report = services.report ?? (value => process.stdout.write(value + "\n"));
  const state = randomBytes(32).toString("base64url"), ticket = randomBytes(32).toString("base64url");
  let localOrigin = "", consumed = false, credentials, busy = false, done = false;
  let expire;
  const server = createServer(async (req, res) => {
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'" };
    const send = (status, body) => { res.writeHead(status, headers); res.end(body); };
    if (req.headers.host !== new URL(localOrigin).host || req.socket.remoteAddress !== "127.0.0.1") { send(403, "Forbidden"); return; }
    const url = new URL(req.url ?? "/", localOrigin);
    const retryPath = `/retry/${ticket}`, finishPath = `/done/${ticket}`;
    async function provision() {
      if (!credentials || busy || done) { send(409, "Setup unavailable"); return; }
      busy = true;
      try {
        await storeSecrets(credentials, { worker, config });
        const publicConfig = { GITHUB_APP_ID: credentials.GITHUB_APP_ID, GITHUB_APP_SLUG: credentials.GITHUB_APP_SLUG, GITHUB_CLIENT_ID: credentials.GITHUB_CLIENT_ID };
        credentials = undefined; done = true;
        report("Credenciais da GitHub App gravadas no Worker " + worker + ".");
        report("Identificadores públicos (podem ir em vars do Wrangler): " + JSON.stringify(publicConfig));
        report("Instalação: https://github.com/apps/" + publicConfig.GITHUB_APP_SLUG + "/installations/new");
        send(200, page("GitHub App configurada", `<p>Credenciais gravadas no Worker <strong>${escapeHtml(worker)}</strong>. Nenhum segredo foi salvo em arquivo.</p><p>Depois de publicar a versão do Veltram com as rotas GitHub, entre na empresa, conecte o GitHub e selecione <strong>dinhogehm/nuria-platform</strong>.</p><p><a href="https://github.com/apps/${escapeHtml(publicConfig.GITHUB_APP_SLUG)}/installations/new">Instalar somente nos repositórios escolhidos</a></p>`));
        clearTimeout(expire); server.close();
      } catch {
        send(503, page("Gravação ainda não confirmada", `<p>A App já foi criada. Os segredos permanecem apenas na memória deste processo. Verifique a autenticação do Wrangler e tente novamente com os mesmos valores.</p><form method="post" action="${retryPath}"><button>Repetir gravação dos mesmos segredos</button></form>`));
      } finally { busy = false; }
    }
    if (req.method === "GET" && url.pathname === `/setup/${ticket}`) {
      const manifest = buildManifest(`${localOrigin}/callback/${ticket}`);
      const action = new URL(organization ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new"); action.searchParams.set("state", state);
      send(200, page("Registrar a GitHub App do Veltram", `<p>Conta proprietária: <strong>${escapeHtml(owner)}</strong>. Worker: <strong>${escapeHtml(worker)}</strong>.</p><p>A App poderá ler e escrever código e criar pull requests apenas nos repositórios escolhidos na instalação. Esta configuração não concede administração de repositórios, Actions, Workflows ou segredos.</p><p>Após você confirmar a criação no GitHub, este processo recebe as credenciais uma única vez e as envia diretamente aos secrets da Cloudflare. Não cria PRs nem modifica repositórios.</p><details><summary>Revisar manifesto</summary><pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></details><form method="post" action="${escapeHtml(action.href)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Continuar para revisar no GitHub</button></form>`)); return;
    }
    if (req.method === "GET" && url.pathname === `/callback/${ticket}`) {
      const code = url.searchParams.get("code");
      if (consumed || !equal(url.searchParams.get("state"), state) || !code || !/^[A-Za-z0-9_-]{20,200}$/.test(code)) { send(400, "Invalid or expired setup state"); return; }
      consumed = true;
      try {
        const response = await request(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "Veltram-Operator" } });
        credentials = validateCredentials(await responseJsonBounded(response), owner);
        res.writeHead(303, { ...headers, location: finishPath }); res.end();
      } catch {
        send(502, page("Conversão não confirmada", "<p>Nenhuma credencial foi exibida. Confira a App nas configurações do GitHub. Se a conversão já tiver consumido o código, gere uma nova chave e client secret na App existente usando o procedimento manual documentado. Não crie uma segunda App automaticamente.</p>"));
      }
      return;
    }
    if (req.method === "GET" && url.pathname === finishPath && credentials && !done) { await provision(); return; }
    if (req.method === "POST" && url.pathname === retryPath && req.headers.origin === localOrigin) { await provision(); return; }
    send(404, "Not found");
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  expire = setTimeout(() => { credentials = undefined; server.closeAllConnections(); server.close(); report("Sessão local de configuração encerrada."); }, lifetimeMs);
  return { url: `${localOrigin}/setup/${ticket}`, close: async () => { clearTimeout(expire); credentials = undefined; server.closeAllConnections(); await new Promise(resolvePromise => server.close(resolvePromise)); } };
}

async function main() {
  const args = process.argv.slice(2), get = (flag, fallback) => { const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1]; };
  const owner = get("--owner", "dinhogehm"), worker = get("--worker", "veltram"), config = resolve(appDirectory, get("--config", "wrangler.production.jsonc"));
  const organization = args.includes("--organization");
  if (!args.includes("--serve")) {
    process.stdout.write("Prévia somente leitura. Nenhum recurso foi criado.\n" + registrationUrl(owner, organization) + "\n\nApós aprovação, iniciar: node scripts/github-app-setup.mjs --serve --approved --owner " + owner + " --worker " + worker + " --config " + config + "\n"); return;
  }
  if (!args.includes("--approved")) throw new Error("O modo --serve exige aprovação prévia e o argumento --approved.");
  const setup = await startSetupServer({ owner, organization, worker, config });
  process.stdout.write("Abra a revisão local: " + setup.url + "\nEste processo só recebe conexões de 127.0.0.1 e expira em 55 minutos.\n");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void setup.close().finally(() => process.exit(0)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("Não foi possível preparar a GitHub App. Consulte o procedimento; nenhum segredo foi exibido.\n"); process.exitCode = 1; });
}
