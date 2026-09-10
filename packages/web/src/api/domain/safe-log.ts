/**
 * Redact secrets before logging (F0 property 8).
 */

const SENSITIVE_KEY =
  /(password|passwd|secret|token|authorization|auth_token|api[_-]?key|access[_-]?token|refresh[_-]?token|client_secret|DATABASE_AUTH_TOKEN|BETTER_AUTH_SECRET)/i;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const QUERY_SECRET_RE =
  /([?&](?:code|access_token|refresh_token|token|password|secret)=)([^&]+)/gi;

export function redactSecrets(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") {
    return input.replace(BEARER_RE, "Bearer [REDACTED]").replace(QUERY_SECRET_RE, "$1[REDACTED]");
  }
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactSecrets(v);
    }
    return out;
  }
  return input;
}

export function safeLog(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.log(message);
    return;
  }
  console.log(message, redactSecrets(meta));
}
