import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../../database/schema";

export type KernelDb = LibSQLDatabase<typeof schema> | LibSQLDatabase<Record<string, never>>;

export type KernelDeps = {
  db: KernelDb;
  getTenantId: () => string;
  now?: () => Date;
};

export function kernelNow(deps: KernelDeps): Date {
  return deps.now ? deps.now() : new Date();
}
