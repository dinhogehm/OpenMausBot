import { HttpError } from "./http";
import { requireMembership } from "./organizations";
import { CODING_LIMITS, codingTreeDigest } from "./coding-types";
import { githubEncoder, githubJson, hash, installationToken, repositoryPath, requireConfigured, validateRef, type GitHubEnv, type GitHubRepository, type RepositoryConnection } from "./github-client";

export interface RepositoryFile { path: string; content: string | null; mode: "100644" | "100755" }
export interface PublicationInput {
  runId: string; baseSha: string; baseTreeSha: string; baseRef: string; task: string;
  files: RepositoryFile[];
  verification: { command: string; exitCode: number; treeDigest: string };
  assertActive: () => Promise<void>;
}
const validSha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const projection = "r.id,r.organization_id AS organizationId,r.installation_id AS installationId,r.repository_id AS repositoryId,r.full_name AS fullName,r.default_branch AS defaultBranch,i.account_id AS accountId";

export async function authorizeRepository(env: GitHubEnv, organizationId: string, userId: string, connectionId: string): Promise<RepositoryConnection> {
  await requireMembership(env.DB, organizationId, userId);
  const connection = await env.DB.prepare(`SELECT ${projection} FROM github_repositories r JOIN github_installations i ON i.installation_id=r.installation_id AND i.organization_id=r.organization_id WHERE r.id=? AND r.organization_id=? AND r.status='active' AND i.status='active' AND i.app_id=?`)
    .bind(connectionId, organizationId, env.GITHUB_APP_ID ?? "").first<Omit<RepositoryConnection, "authorizedUserId">>();
  if (!connection) throw new HttpError(404, "github_repository_unavailable");
  return { ...connection, authorizedUserId: userId };
}
async function assertConnection(env: GitHubEnv, connection: RepositoryConnection): Promise<void> {
  const current = await authorizeRepository(env, connection.organizationId, connection.authorizedUserId, connection.id);
  if (current.installationId !== connection.installationId || current.repositoryId !== connection.repositoryId || current.accountId !== connection.accountId || current.fullName !== connection.fullName) {
    throw new HttpError(409, "github_connection_changed");
  }
}
async function repositoryToken(env: GitHubEnv, connection: RepositoryConnection, write = false, readPullRequests = false): Promise<string> {
  requireConfigured(env);
  await assertConnection(env, connection);
  const token = await installationToken(env, connection, write, readPullRequests);
  const repository = await githubJson<GitHubRepository>(token, repositoryPath(connection));
  if (!repository || repository.id !== connection.repositoryId || repository.owner?.id !== connection.accountId || repository.archived || repository.disabled
    || repository.full_name.toLowerCase() !== connection.fullName.toLowerCase()) throw new HttpError(403, "github_access_revoked");
  return token;
}
export async function prepareRepository(env: GitHubEnv, connection: RepositoryConnection, baseRef: string): Promise<{ baseSha: string; baseTreeSha: string; archive: ReadableStream<Uint8Array> }> {
  validateRef(baseRef);
  const token = await repositoryToken(env, connection);
  const commit = await githubJson<{ sha: string; commit: { tree: { sha: string } } }>(token, `${repositoryPath(connection)}/commits/${encodeURIComponent(baseRef)}`);
  if (!commit || !validSha(commit.sha) || !validSha(commit.commit?.tree?.sha)) throw new HttpError(503, "github_invalid_response");
  await assertConnection(env, connection);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${repositoryPath(connection)}/tarball/${commit.sha}`, {
      redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "Veltram" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new HttpError(503, "github_archive_unavailable");
      const url = new URL(location);
      if (url.protocol !== "https:" || url.hostname !== "codeload.github.com" || url.port || url.username || url.password
        || !url.pathname.toLowerCase().startsWith(`/${connection.fullName.toLowerCase()}/`) || !url.pathname.endsWith(`/${commit.sha}`)) throw new HttpError(503, "github_archive_redirect_forbidden");
      // GitHub's signed archive URL is used without forwarding the installation token.
      response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(60_000), headers: { "user-agent": "Veltram" } });
    }
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "github_archive_unavailable"); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new HttpError(503, "github_archive_unavailable"); }
  const reader = response.body.getReader();
  let size = 0;
  const archive = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); return; }
        size += value.byteLength;
        if (size > 64 * 1024 * 1024) { await reader.cancel(); controller.error(new HttpError(413, "github_archive_too_large")); return; }
        controller.enqueue(value);
      } catch { controller.error(new HttpError(503, "github_archive_unavailable")); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return { baseSha: commit.sha, baseTreeSha: commit.commit.tree.sha, archive };
}
export function validateRepositoryFiles(files: RepositoryFile[]): RepositoryFile[] {
  if (!Array.isArray(files) || !files.length || files.length > CODING_LIMITS.files) throw new HttpError(400, "github_invalid_changes");
  const seen = new Set<string>();
  let size = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !file.path.isWellFormed() || file.path.length > 500 || file.path.includes("\\") || /\p{Cc}/u.test(file.path)
      || file.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
      || /^\.github(?:$|\/workflows(?:\/|$))/i.test(file.path) || seen.has(file.path) || !["100644", "100755"].includes(file.mode)) throw new HttpError(400, "github_invalid_changes");
    if (file.content !== null && (typeof file.content !== "string" || !file.content.isWellFormed() || file.content.includes("\0"))) throw new HttpError(400, "github_invalid_changes");
    const length = file.content === null ? 0 : githubEncoder.encode(file.content).byteLength;
    size += length;
    if (length > CODING_LIMITS.fileBytes || size > CODING_LIMITS.changeBytes) throw new HttpError(413, "github_changes_too_large");
    seen.add(file.path);
  }
  return [...files].sort((a, b) => {
    const left = githubEncoder.encode(a.path), right = githubEncoder.encode(b.path);
    for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
    return left.length - right.length;
  });
}
export async function publicationDigest(files: RepositoryFile[]): Promise<string> {
  return codingTreeDigest(validateRepositoryFiles(files));
}
interface PublicationRow { fingerprint: string; branch: string; tree_sha: string | null; commit_sha: string | null; pr_url: string | null; pr_number: number | null; created_at: number }
interface Pull { number: number; html_url: string; head: { sha: string; ref: string; repo: { id: number } }; base: { ref: string; repo: { id: number } }; state: string }

/** Looks up an uncertain publication; it never creates blobs, commits, branches or PRs. */
export async function reconcileRepositoryPublication(env: GitHubEnv, connection: RepositoryConnection,
  input: Pick<PublicationInput, "runId" | "baseSha" | "baseTreeSha" | "baseRef" | "task" | "verification">,
): Promise<{ branch: string; commitSha: string; prUrl: string; prNumber: number } | null> {
  validateRef(input.baseRef);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.runId) || !validSha(input.baseSha) || !validSha(input.baseTreeSha)
    || input.verification.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(input.verification.treeDigest)) return null;
  await assertConnection(env, connection);
  const row = await env.DB.prepare("SELECT * FROM github_publications WHERE run_id=? AND organization_id=? AND connection_id=?")
    .bind(input.runId, connection.organizationId, connection.id).first<PublicationRow>();
  const branch = `veltram/${input.runId}`;
  const fingerprint = await hash(JSON.stringify([connection.organizationId, connection.repositoryId, input.baseRef, input.baseSha, input.verification.treeDigest, input.task, input.verification.command]));
  if (!row || row.fingerprint !== fingerprint || row.branch !== branch || !row.commit_sha || !validSha(row.commit_sha) || !row.tree_sha || !validSha(row.tree_sha)) return null;
  const token = await repositoryToken(env, connection, false, true), path = repositoryPath(connection);
  const base = await githubJson<{ tree: { sha: string } }>(token, `${path}/git/commits/${input.baseSha}`, { allow404: true });
  if (base?.tree?.sha !== input.baseTreeSha) return null;
  const commit = await githubJson<{ sha: string; tree: { sha: string }; parents: { sha: string }[] }>(token, `${path}/git/commits/${row.commit_sha}`, { allow404: true });
  if (commit?.sha !== row.commit_sha || commit.tree?.sha !== row.tree_sha || commit.parents?.length !== 1 || commit.parents[0].sha !== input.baseSha) return null;
  const reference = await githubJson<{ object: { sha: string } }>(token, `${path}/git/ref/heads/${branch}`, { allow404: true });
  if (reference?.object?.sha !== row.commit_sha) return null;
  const pulls = await githubJson<Pull[]>(token, `${path}/pulls?state=all&head=${encodeURIComponent(connection.fullName.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(input.baseRef)}&per_page=100`);
  const pull = pulls?.find(candidate => candidate.head?.ref === branch && candidate.head.sha === row.commit_sha && candidate.head.repo?.id === connection.repositoryId
    && candidate.base?.ref === input.baseRef && candidate.base.repo?.id === connection.repositoryId);
  if (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1 || pull.html_url !== `https://github.com/${connection.fullName}/pull/${pull.number}`) return null;
  await assertConnection(env, connection);
  return { branch, commitSha: row.commit_sha, prUrl: pull.html_url, prNumber: pull.number };
}

export async function publishRepository(env: GitHubEnv, connection: RepositoryConnection, input: PublicationInput): Promise<{ branch: string; commitSha: string; prUrl: string; prNumber: number }> {
  validateRef(input.baseRef);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.runId) || !validSha(input.baseSha) || !validSha(input.baseTreeSha)
    || typeof input.task !== "string" || !input.task.trim() || input.task.length > 20_000 || !input.task.isWellFormed()
    || input.verification.exitCode !== 0 || !input.verification.command || input.verification.command.length > 2000) throw new HttpError(400, "github_publication_invalid");
  const files = validateRepositoryFiles(input.files);
  const digest = await publicationDigest(files);
  if (digest !== input.verification.treeDigest) throw new HttpError(409, "github_verification_mismatch");
  const guard = async () => { await input.assertActive(); await assertConnection(env, connection); };
  await guard();
  const token = await repositoryToken(env, connection, true);
  const path = repositoryPath(connection), branch = `veltram/${input.runId}`;
  const fingerprint = await hash(JSON.stringify([connection.organizationId, connection.repositoryId, input.baseRef, input.baseSha, digest, input.task, input.verification.command]));
  await env.DB.prepare("INSERT OR IGNORE INTO github_publications (run_id,organization_id,connection_id,fingerprint,branch,created_at) VALUES (?,?,?,?,?,?)")
    .bind(input.runId, connection.organizationId, connection.id, fingerprint, branch, Date.now()).run();
  const row = await env.DB.prepare("SELECT * FROM github_publications WHERE run_id=? AND organization_id=? AND connection_id=?")
    .bind(input.runId, connection.organizationId, connection.id).first<PublicationRow>();
  if (!row || row.fingerprint !== fingerprint || row.branch !== branch) throw new HttpError(409, "github_publication_conflict");
  // Confirm the caller's base tree belongs to the pinned base commit.
  const base = await githubJson<{ tree: { sha: string } }>(token, `${path}/git/commits/${input.baseSha}`);
  if (base?.tree?.sha !== input.baseTreeSha) throw new HttpError(409, "github_verification_mismatch");
  let treeSha = row.tree_sha;
  if (!treeSha) {
    const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const file of files) {
      let sha: string | null = null;
      if (file.content !== null) {
        await guard();
        const blob = await githubJson<{ sha: string }>(token, `${path}/git/blobs`, { method: "POST", body: { content: file.content, encoding: "utf-8" } });
        if (!blob || !validSha(blob.sha)) throw new HttpError(503, "github_invalid_response");
        sha = blob.sha;
      }
      entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
    }
    await guard();
    const tree = await githubJson<{ sha: string }>(token, `${path}/git/trees`, { method: "POST", body: { base_tree: input.baseTreeSha, tree: entries } });
    if (!tree || !validSha(tree.sha) || tree.sha === input.baseTreeSha) throw new HttpError(409, "github_no_changes");
    treeSha = tree.sha;
    await env.DB.prepare("UPDATE github_publications SET tree_sha=? WHERE run_id=? AND fingerprint=?").bind(treeSha, input.runId, fingerprint).run();
  }
  let commitSha = row.commit_sha;
  if (!commitSha) {
    await guard();
    const author = { name: "Veltram", email: "noreply@veltram.com", date: new Date(row.created_at).toISOString() };
    const commit = await githubJson<{ sha: string }>(token, `${path}/git/commits`, { method: "POST", body: { message: `Veltram: ${input.task.split(/\r?\n/, 1)[0].slice(0, 120)}\n\nVeltram-Run: ${input.runId}`, tree: treeSha, parents: [input.baseSha], author, committer: author } });
    if (!commit || !validSha(commit.sha)) throw new HttpError(503, "github_invalid_response");
    commitSha = commit.sha;
    await env.DB.prepare("UPDATE github_publications SET commit_sha=? WHERE run_id=? AND fingerprint=?").bind(commitSha, input.runId, fingerprint).run();
  }
  const refPath = `${path}/git/ref/heads/${branch}`;
  let reference = await githubJson<{ object: { sha: string } }>(token, refPath, { allow404: true });
  if (!reference) {
    await guard();
    try { await githubJson(token, `${path}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commitSha } }); }
    catch (error) {
      reference = await githubJson<{ object: { sha: string } }>(token, refPath, { allow404: true });
      if (!reference || reference.object.sha !== commitSha) throw error;
    }
    reference ??= await githubJson<{ object: { sha: string } }>(token, refPath);
  }
  if (reference?.object?.sha !== commitSha) throw new HttpError(409, "github_branch_changed");
  const findPull = async () => {
    const pulls = await githubJson<Pull[]>(token, `${path}/pulls?state=all&head=${encodeURIComponent(connection.fullName.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(input.baseRef)}&per_page=100`);
    return pulls?.find(pull => pull.head?.ref === branch && pull.head.repo?.id === connection.repositoryId && pull.base?.ref === input.baseRef && pull.base.repo?.id === connection.repositoryId);
  };
  let pull = await findPull();
  if (!pull) {
    await guard();
    try {
      pull = await githubJson<Pull>(token, `${path}/pulls`, { method: "POST", body: {
        title: `Veltram: ${input.task.split(/\r?\n/, 1)[0].slice(0, 120)}`,
        head: branch, base: input.baseRef, draft: true,
        body: `Implementação produzida para esta tarefa:\n\n${input.task}\n\nVerificação executada na Cloudflare:\n\n\`\`\`text\n${input.verification.command.replaceAll("```", "'''")}\nexitCode: 0\n\`\`\`\n\nBase: \`${input.baseSha}\`\nÁrvore publicada: \`${treeSha}\`\nRecibo: \`${digest}\`\n\n<!-- veltram-run:${input.runId} -->`,
      } });
    } catch (error) { pull = await findPull(); if (!pull) throw error; }
  }
  if (!pull || !Number.isSafeInteger(pull.number) || pull.number <= 0 || pull.head?.sha !== commitSha || !pull.html_url.startsWith(`https://github.com/${connection.fullName}/pull/`)) throw new HttpError(409, "github_pr_changed");
  await env.DB.prepare("UPDATE github_publications SET pr_url=?,pr_number=? WHERE run_id=? AND fingerprint=?").bind(pull.html_url, pull.number, input.runId, fingerprint).run();
  return { branch, commitSha, prUrl: pull.html_url, prNumber: pull.number };
}
