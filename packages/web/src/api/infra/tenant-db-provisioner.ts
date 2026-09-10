import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyDomainKernelSchema } from "./kernel-schema";

export type ProvisionedDatabase = {
  dbRef: string;
  client: Client;
};

export type TenantDbProvisioner = {
  /** Create (or open) the physical DB for a tenant. Must be safe to call twice. */
  provision(tenantId: string): Promise<ProvisionedDatabase>;
};

function sanitizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Local file provisioner — proves 1 DB per tenant without Turso credentials.
 * db_ref = file URL under TENANT_DB_ROOT (default ./data/tenants).
 */
export function createLocalFileTenantProvisioner(options?: {
  rootDir?: string;
  applyKernelSchema?: boolean;
}): TenantDbProvisioner {
  const rootDir =
    options?.rootDir ??
    (String(process.env.TENANT_DB_ROOT ?? "").trim() ||
      path.join(process.cwd(), "data", "tenants"));
  const applyKernel = options?.applyKernelSchema !== false;

  return {
    async provision(tenantId: string): Promise<ProvisionedDatabase> {
      fs.mkdirSync(rootDir, { recursive: true });
      const filePath = path.join(rootDir, `${sanitizeTenantId(tenantId)}.db`);
      const dbRef = `file:${filePath}`;
      const client = createClient({ url: dbRef });
      if (applyKernel) {
        await applyDomainKernelSchema(client);
      }
      return { dbRef, client };
    },
  };
}

/**
 * Register an already-existing DB (e.g. Fonte DATABASE_URL) without creating a new file.
 */
export function createExistingDbProvisioner(dbRef: string): TenantDbProvisioner {
  return {
    async provision(): Promise<ProvisionedDatabase> {
      const client = createClient({
        url: dbRef,
        authToken: process.env.DATABASE_AUTH_TOKEN,
      });
      return { dbRef, client };
    },
  };
}
