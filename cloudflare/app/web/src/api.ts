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
