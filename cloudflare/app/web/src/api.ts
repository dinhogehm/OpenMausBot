export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const messages: Record<string, string> = {
  sign_in_required: "Sua sessão terminou. Entre novamente para continuar.",
  origin_forbidden: "Não foi possível confirmar esta solicitação. Atualize a página e tente novamente.",
  origin_not_configured: "Este endereço ainda não está pronto para acesso. Tente novamente mais tarde.",
  invalid_name: "Informe um nome de empresa com até 100 caracteres.",
  organization_limit: "Você atingiu o limite de empresas desta conta.",
  admin_required: "Somente administradores podem realizar esta alteração.",
  credential_changed: "A chave foi alterada em outra sessão. Atualize os dados antes de tentar novamente.",
  credential_write_limit: "O limite de alterações de chaves foi atingido. Tente novamente em uma hora.",
  invalid_key: "Confira a chave. Ela deve ter entre 8 e 4.096 caracteres, sem espaços.",
  otp_rate_limited: "Muitos códigos foram solicitados. Aguarde alguns minutos antes de tentar novamente.",
  run_conflict: "O estado deste teste mudou. Atualize o histórico para continuar.",
  invalid_run_state: "O estado deste teste mudou. Atualize o histórico para continuar.",
  run_limit: "O limite de testes foi atingido. Aguarde antes de criar outro.",
  run_capacity: "Já existem testes em andamento. Aguarde a conclusão para iniciar outro.",
  github_not_configured: "A conexão com o GitHub ainda está em preparação. O responsável pela Veltram precisa concluir a configuração.",
  github_access_revoked: "O acesso ao repositório foi removido no GitHub. Conecte sua conta novamente para atualizar o acesso.",
  github_state_invalid: "A confirmação do GitHub expirou ou não corresponde a esta sessão. Inicie a conexão novamente.",
  github_installation_claimed: "Esta instalação do GitHub já está vinculada a outra empresa.",
  github_owner_required: "A conexão precisa ser confirmada pelo responsável pela conta ou organização no GitHub.",
  github_selection_expired: "A seleção de repositórios expirou. Atualize o acesso ao GitHub e tente novamente.",
  coding_capacity: "Já há uma tarefa em execução ou toda a capacidade está ocupada. Aguarde e tente novamente.",
  coding_conflict: "O estado da tarefa mudou. Atualize o histórico antes de tentar novamente.",
  coding_limit: "Esta empresa atingiu o limite de tarefas disponível.",
  agents_changed: "A equipe foi alterada em outra sessão. Recarregue a configuração antes de salvar novamente.",
  agent_catalog_changed: "O catálogo de agentes mudou. Feche e abra novamente este formulário para conferir os perfis atuais.",
  invalid_browser_task: "Descreva o objetivo e confira o site, o modelo e os domínios permitidos.",
  invalid_browser_host: "Informe somente nomes exatos de sites públicos, sem caminhos, IPs ou curingas.",
  invalid_browser_url: "Informe um endereço HTTPS público de um dos domínios permitidos.",
  browser_unavailable: "O navegador na nuvem está indisponível neste momento. Tente novamente mais tarde.",
  browser_key_unavailable: "Adicione uma chave do provedor de IA antes de criar esta tarefa.",
  browser_key_changed: "A chave de IA mudou. Crie uma nova tarefa para usar a configuração atual.",
  browser_model_unavailable: "O provedor não concluiu a chamada. Confira a chave e se o modelo aceita imagens.",
  browser_model_context_limit: "A página excedeu o limite de conteúdo desta tarefa. Tente um objetivo mais específico.",
  browser_model_response: "O modelo retornou uma ação que não pôde ser validada. A tarefa foi interrompida.",
  browser_model_response_limit: "A resposta do modelo excedeu o limite desta tarefa.",
  browser_invalid_action: "A ação sugerida não é permitida nesta sessão de navegador.",
  marketplace_version_changed: "Este item mudou. Feche os detalhes e abra novamente antes de instalar.",
  marketplace_external_only: "Este item está disponível como referência externa. Abra o link de origem para consultá-lo.",
  marketplace_profiles_changed: "Estes perfis foram personalizados na empresa. A instalação foi interrompida para preservar suas alterações.",
  marketplace_not_found: "Este item não está disponível no catálogo. Atualize a página e escolha novamente.",
  agent_import_changed: "Esta importação já foi enviada com outro conteúdo. Reabra o arquivo para conferir os perfis.",
  invalid_agent_catalog: "Confira o arquivo de agentes e os limites de cada perfil.",
  agent_catalog_too_large: "O catálogo excede o limite de 100 agentes ou 256 KiB. Divida ou reduza os perfis.",
  invalid_agent_selection: "Selecione um agente disponível para cada papel da equipe.",
  invalid_agents: "Confira os nomes, as instruções e os modelos dos três agentes.",
  coding_state_changed: "O estado da tarefa mudou. Atualize o histórico antes de tentar novamente.",
  coding_history_limit: "Esta empresa atingiu o limite de tarefas disponível.",
  coding_key_required: "Adicione uma chave de IA para cada provedor usado pela equipe antes de criar a tarefa.",
  coding_key_changed: "Uma chave de IA mudou depois da criação desta tarefa. Crie uma nova tarefa para usar a configuração atual.",
  coding_execution_failed: "A execução não pôde ser concluída. Confira o último registro disponível.",
  coding_step_uncertain: "A etapa foi interrompida e seu resultado não está confirmado. Ela não será repetida automaticamente.",
  coding_publication_uncertain: "A publicação foi interrompida; pode existir uma branch ou PR no GitHub. Confira o repositório antes de repetir.",
  coding_tests_failed: "Os testes continuaram falhando após as tentativas de correção. Nenhum novo PR foi confirmado.",
  coding_review_rejected: "O revisor solicitou correções que não foram resolvidas nesta tarefa. Confira o parecer e os testes.",
  coding_tree_changed_during_tests: "Os arquivos mudaram durante os testes. O resultado não certifica a alteração final e o PR não foi criado.",
  coding_setup_failed: "O comando de preparação do projeto falhou. Confira a saída registrada.",
  coding_no_changes: "O agente não produziu alterações de arquivos para entregar.",
  coding_model_budget: "A tarefa atingiu o limite de uso de IA antes de concluir.",
  coding_context_limit: "O conteúdo necessário excedeu o limite desta tarefa. Divida o pedido em alterações menores.",
  coding_deadline_elapsed: "A tarefa atingiu o limite de tempo de execução.",
  model_request_failed: "O provedor de IA não concluiu a chamada. Confira a chave, o modelo e os limites da conta.",
  EMAIL_OTP_INVALID: "O código está incorreto ou expirou. Confira os oito dígitos ou peça um novo código.",
  INVALID_OTP: "O código está incorreto ou expirou. Confira os oito dígitos ou peça um novo código.",
  OTP_EXPIRED: "Este código expirou. Solicite um novo para continuar.",
  TOO_MANY_ATTEMPTS: "Muitas tentativas. Solicite um novo código após alguns minutos.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (messages[error.code]) return messages[error.code];
    if (error.status === 401) return "Não foi possível entrar. Confira o código ou solicite outro.";
    if (error.status === 403) return "Seu acesso não permite realizar esta ação.";
    if (error.status === 404) return "Este recurso não está disponível para sua conta. Atualize os dados.";
    if (error.status === 409) return "Os dados mudaram em outra sessão. Atualize antes de tentar novamente.";
    if (error.status === 429) return "Muitas solicitações. Aguarde alguns minutos e tente novamente.";
    if (error.status === 400) return "Confira os campos e tente novamente.";
  }
  return "Não foi possível concluir a solicitação. Confira sua conexão e tente novamente.";
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: options.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const data = await response.json().catch((error: unknown) => {
    if (isAbort(error) || response.ok) throw error;
    return {};
  }) as Record<string, unknown>;
  // A previous tenant/session may have been discarded while its body streamed.
  options.signal?.throwIfAborted();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("veltram:session-expired"));
    }
    throw new ApiError(response.status, typeof data.error === "string" ? data.error : typeof data.code === "string" ? data.code : "request_failed");
  }
  return data as T;
}

export interface User { id: string; name: string; email: string }
export interface Organization { id: string; name: string; role: "owner" | "admin" | "member" }
export interface Workspace { id: string; name: string }
export interface Credential { provider: string; version: number; status: "configured" | "revoked"; updatedAt: number }

export function organizationPath(organizationId: string): string {
  return `/api/organizations/${encodeURIComponent(organizationId)}`;
}

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
