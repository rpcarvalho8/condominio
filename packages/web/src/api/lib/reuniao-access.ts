import { and, eq } from "drizzle-orm";
import { db } from "../database";
import { reunioes } from "../database/schema";
import { getCurrentTenantId } from "./tenant";

export type ReuniaoRow = typeof reunioes.$inferSelect;

/**
 * Carrega reunião apenas se pertencer ao tenant actual.
 * Nunca confiar só no reuniaoId do cliente.
 */
export async function findReuniaoForCurrentTenant(
  reuniaoId: string,
  tenantId = getCurrentTenantId(),
): Promise<ReuniaoRow | null> {
  const [row] = await db
    .select()
    .from(reunioes)
    .where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function listReunioesForCurrentTenant(
  tenantId = getCurrentTenantId(),
) {
  return db
    .select()
    .from(reunioes)
    .where(eq(reunioes.tenantId, tenantId));
}
