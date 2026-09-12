import { DomainError } from "../../domain/errors";
import { hashOpaqueSecret } from "../../domain/invitation";

export const F3_PUBLIC_RATE_WINDOW_MS = 60_000;
export const F3_PUBLIC_RATE_MAX = 20;

const buckets = new Map<string, number[]>();

export function resetF3PublicRateLimit(): void {
  buckets.clear();
}

export function clientIpFromHeaders(header: (name: string) => string | undefined): string {
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || header("x-real-ip")?.trim() || "local";
}

/** Minimal IP + invitation-token limiter for public F3 endpoints. */
export function assertF3PublicRateLimit(input: {
  ip: string;
  token: string;
  action: string;
}): void {
  const tokenPart = hashOpaqueSecret(input.token).slice(0, 16);
  const key = `${input.action}:${input.ip}:${tokenPart}`;
  const now = Date.now();
  const windowStart = now - F3_PUBLIC_RATE_WINDOW_MS;
  const recent = (buckets.get(key) ?? []).filter((ts) => ts > windowStart);
  if (recent.length >= F3_PUBLIC_RATE_MAX) {
    throw new DomainError(
      "public_rate_limited",
      "Demasiados pedidos. Tente novamente mais tarde.",
      429,
    );
  }
  recent.push(now);
  buckets.set(key, recent);
}
