import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as platformSchema from "./schema";

export type PlatformDb = LibSQLDatabase<typeof platformSchema>;

export type PlatformSqlClient = Client;

/**
 * Resolve platform DB URL.
 * Prefer PLATFORM_DATABASE_URL; fall back to a local file next to the process
 * so F0-B works without inventing a second remote Turso account in every env.
 */
export function resolvePlatformDatabaseUrl(): string {
  const fromEnv = String(process.env.PLATFORM_DATABASE_URL ?? "").trim();
  if (fromEnv) return fromEnv;
  return "file:./platform.db";
}

export function createPlatformClient(url = resolvePlatformDatabaseUrl()): PlatformSqlClient {
  return createClient({
    url,
    authToken: process.env.PLATFORM_DATABASE_AUTH_TOKEN,
  });
}

export function createPlatformDb(client: PlatformSqlClient = createPlatformClient()): PlatformDb {
  return drizzle(client, { schema: platformSchema });
}

/** Lazy singleton for the running app — tests inject their own client. */
let defaultClient: PlatformSqlClient | null = null;
let defaultDb: PlatformDb | null = null;

export function getPlatformClient(): PlatformSqlClient {
  if (!defaultClient) defaultClient = createPlatformClient();
  return defaultClient;
}

export function getPlatformDb(): PlatformDb {
  if (!defaultDb) defaultDb = createPlatformDb(getPlatformClient());
  return defaultDb;
}
