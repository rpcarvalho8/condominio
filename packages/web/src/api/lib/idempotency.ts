import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../database";
import { idempotencyKeys } from "../database/schema";

const TTL_MS = 24 * 60 * 60 * 1000;

export function readIdempotencyKey(c: Context): string | null {
  const raw =
    c.req.header("Idempotency-Key")
    || c.req.header("idempotency-key")
    || "";
  const key = raw.trim();
  if (!key || key.length > 128) return null;
  return key;
}

function compositeKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

/**
 * Executa handler uma vez por Idempotency-Key.
 * Sem header → executa normalmente (compatibilidade).
 * Com header já concluído → devolve resposta em cache (sem reexecutar).
 */
export async function withIdempotency<T>(
  c: Context,
  scope: string,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<Response> {
  const key = readIdempotencyKey(c);
  if (!key) {
    const result = await handler();
    return c.json(result.body as any, result.status as any);
  }

  const id = compositeKey(scope, key);
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.id, id))
    .limit(1);

  if (existing) {
    if (existing.status === "completed" && existing.responseBody) {
      try {
        const body = JSON.parse(existing.responseBody);
        return c.json(body, (existing.responseStatus || 200) as any);
      } catch {
        /* fall through to re-run if corrupt */
      }
    }
    if (existing.status === "pending") {
      return c.json({ message: "Pedido já em processamento. Aguarde." }, 409);
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_MS);

  try {
    await db.insert(idempotencyKeys).values({
      id,
      scope,
      key,
      status: "pending",
      createdAt: now,
      expiresAt,
    });
  } catch {
    // Race: outra request inseriu — ler de novo
    const [race] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, id))
      .limit(1);
    if (race?.status === "completed" && race.responseBody) {
      return c.json(JSON.parse(race.responseBody), (race.responseStatus || 200) as any);
    }
    return c.json({ message: "Pedido já em processamento. Aguarde." }, 409);
  }

  try {
    const result = await handler();
    await db.update(idempotencyKeys).set({
      status: "completed",
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
      completedAt: new Date(),
    }).where(eq(idempotencyKeys.id, id));
    return c.json(result.body as any, result.status as any);
  } catch (e) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
    throw e;
  }
}
