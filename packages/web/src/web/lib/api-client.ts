/**
 * Cliente HTTP partilhado — timeouts, erros humanos, Idempotency-Key, offline.
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Mensagem acionável — nunca stack / JSON cru. */
export function humanizeNetworkError(err: unknown): string {
  if (!isOnline()) {
    return "Sem ligação à internet. Os dados locais estão seguros — tente quando a rede voltar.";
  }
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return "Sessão expirada. Volte a iniciar sessão.";
    if (err.status === 404) return "Registo não encontrado. Actualize a página.";
    if (err.status === 409) return err.message || "Conflito — outro utilizador pode ter alterado estes dados.";
    if (err.status === 413) return "Ficheiro demasiado grande. Reduza o tamanho e tente outra vez.";
    if (err.status >= 500) return "O servidor está temporariamente indisponível. Tente dentro de um minuto.";
    return err.message || "Não foi possível concluir o pedido.";
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/abort|timeout|Timeout/i.test(msg)) {
    return "A operação demorou demasiado. Verifique a rede e tente outra vez.";
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
    return "Sem ligação estável. Verifique o Wi‑Fi e tente outra vez.";
  }
  if (msg && msg.length < 160 && !/^\s*\{/.test(msg) && !/at\s+\S+\s+\(/.test(msg)) {
    return msg;
  }
  return "Algo correu mal. Tente outra vez — se persistir, contacte o suporte.";
}

export type ApiFetchOptions = RequestInit & {
  token?: string | null;
  timeoutMs?: number;
  /** Nº de tentativas extra em erros de rede / 5xx. Default 0. */
  retries?: number;
  /**
   * true → gera UUID e reutiliza em todos os retries.
   * string → usa essa chave.
   */
  idempotent?: boolean | string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const {
    token,
    timeoutMs = 30_000,
    retries = 0,
    idempotent,
    headers: initHeaders,
    ...init
  } = opts;

  const idemKey =
    idempotent === true
      ? newIdempotencyKey()
      : typeof idempotent === "string" && idempotent
        ? idempotent
        : null;

  let attempt = 0;
  while (true) {
    if (!isOnline()) {
      throw new ApiError("Sem ligação à internet. Tente quando a rede voltar.", 0);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
          ...(initHeaders ?? {}),
        },
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const message = String(
          (data as any).message ?? (data as any).error ?? res.statusText ?? "Erro",
        );
        throw new ApiError(message, res.status);
      }
      return data as T;
    } catch (e) {
      const retryable =
        attempt < retries
        && !(e instanceof ApiError && e.status > 0 && e.status < 500 && e.status !== 408 && e.status !== 429)
        && (
          !isOnline()
          || (e instanceof ApiError && (e.status >= 500 || e.status === 0 || e.status === 408 || e.status === 429))
          || (e instanceof Error && /abort|Failed to fetch|NetworkError/i.test(e.message))
        );
      if (!retryable) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(humanizeNetworkError(e), 0);
      }
      attempt++;
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}
