import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { PlatformDb } from "../platform/database";
import { createTenantDirectoryRepo } from "./repos/tenant-directory-repo";
import { DomainError } from "../domain/errors";
import { TENANT_STATUS } from "../domain/tenant-directory";
import * as schema from "../database/schema";
import type { KernelDb } from "./kernel-deps";

type CacheEntry = {
  client: Client;
  db: KernelDb;
  dbRef: string;
  lastUsed: number;
};

/**
 * Stateless tenant DB access with LRU cache (F0 connection strategy).
 * Never accept db_ref from the client — only from TenantDirectory.
 */
export function createTenantClientCache(options?: { maxEntries?: number }) {
  const maxEntries = options?.maxEntries ?? 32;
  const cache = new Map<string, CacheEntry>();

  function touch(tenantId: string, entry: CacheEntry) {
    entry.lastUsed = Date.now();
    cache.delete(tenantId);
    cache.set(tenantId, entry);
  }

  function evictIfNeeded() {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const old = cache.get(oldestKey);
      cache.delete(oldestKey);
      try {
        old?.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    async getDb(platformDb: PlatformDb, tenantId: string): Promise<KernelDb> {
      const id = tenantId.trim();
      if (!id) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);

      const cached = cache.get(id);
      if (cached) {
        touch(id, cached);
        return cached.db;
      }

      const entry = await createTenantDirectoryRepo(platformDb).findById(id);
      if (!entry || entry.status !== TENANT_STATUS.active) {
        throw new DomainError("tenant_invalid", "Contexto de tenant inválido", 403);
      }

      const client = createClient({
        url: entry.dbRef,
        authToken: process.env.DATABASE_AUTH_TOKEN,
      });
      const db = drizzle(client, { schema }) as unknown as KernelDb;
      const created: CacheEntry = {
        client,
        db,
        dbRef: entry.dbRef,
        lastUsed: Date.now(),
      };
      cache.set(id, created);
      evictIfNeeded();
      return db;
    },
    /** Test helper — inspect which tenant DBs are open. */
    openTenantIds(): string[] {
      return [...cache.keys()];
    },
    clear() {
      for (const entry of cache.values()) {
        try {
          entry.client.close();
        } catch {
          /* ignore */
        }
      }
      cache.clear();
    },
  };
}

export type TenantClientCache = ReturnType<typeof createTenantClientCache>;
