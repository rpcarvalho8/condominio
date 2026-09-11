import { eq } from "drizzle-orm";
import { roles } from "../../database/schema";
import { KERNEL_ROLE_CATALOG, type KernelRoleCode } from "../../domain/roles";
import type { KernelDb } from "../kernel-deps";

export function createRoleRepo(db: KernelDb) {
  return {
    async findByCode(code: string) {
      const [row] = await db.select().from(roles).where(eq(roles.code, code)).limit(1);
      return row ?? null;
    },
    async list() {
      return db.select().from(roles);
    },
    async ensureSeeded(now = new Date()) {
      for (const role of KERNEL_ROLE_CATALOG) {
        const existing = await db.select().from(roles).where(eq(roles.code, role.code)).limit(1);
        if (existing.length > 0) continue;
        await db.insert(roles).values({
          code: role.code,
          name: role.name,
          description: role.description,
          createdAt: now,
        });
      }
    },
  };
}

export type RoleRepo = ReturnType<typeof createRoleRepo>;

export type { KernelRoleCode };
