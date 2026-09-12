import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../../database/schema";
import type { EnableBankingClient } from "../application/finance/enable-banking-adapter";

export type KernelDb = LibSQLDatabase<typeof schema> | LibSQLDatabase<Record<string, never>>;

export type KernelDeps = {
  db: KernelDb;
  getTenantId: () => string;
  now?: () => Date;
  /**
   * Optional TenantDirectory gate (F0-B).
   * When set, unknown/inactive tenants fail closed with 403.
   */
  assertTenantActive?: (tenantId: string) => Promise<void>;
  /** Enable Banking / PSD2 client. Tests inject a mock; produção usa env. */
  enableBanking?: EnableBankingClient;
};

export function kernelNow(deps: KernelDeps): Date {
  return deps.now ? deps.now() : new Date();
}
