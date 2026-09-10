/**
 * F0 complete — propriedades testáveis 1–10 (06-FATIAS).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import {
  auditEvents,
  contentUploads,
  domainEvents,
  memberships,
  notificationDeliveries,
  outboxJobs,
  persons,
  policies,
  roles,
} from "./database/schema";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyPlatformSchema } from "./platform/apply-schema";
import { createPlatformDb } from "./platform/database";
import { createLocalFileTenantProvisioner } from "./infra/tenant-db-provisioner";
import { provisionTenant } from "./application/platform/provision-tenant";
import { createMembership } from "./application/identity/create-membership";
import { revokeMembership } from "./application/identity/revoke-membership";
import { processOutbox } from "./application/jobs/process-outbox";
import { enqueueOutboxJob } from "./application/events/emit";
import { registerContentUpload } from "./application/uploads/register-content-upload";
import { createTenantClientCache } from "./infra/tenant-client-cache";
import { migrateAllTenants } from "./infra/migrate-all-tenants";
import { backupTenantDatabase, restoreTenantDatabase } from "./infra/tenant-backup";
import { redactSecrets } from "./domain/safe-log";
import { OUTBOX_JOB_TYPES } from "./domain/outbox";
import { OUTBOX_STATUS } from "./domain/outbox";
import type { KernelDeps } from "./infra/kernel-deps";
import { createOutboxRepo } from "./infra/repos/outbox-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import { eq } from "drizzle-orm";

const ROOT = path.join(import.meta.dir, "..", "..", ".tmp-test-f0");
const PLATFORM_DB = path.join(ROOT, "platform.db");
const TENANTS_DIR = path.join(ROOT, "tenants");
const BACKUP_DIR = path.join(ROOT, "backups");

const schema = {
  persons,
  memberships,
  roles,
  auditEvents,
  domainEvents,
  outboxJobs,
  policies,
  contentUploads,
  notificationDeliveries,
};

let platformClient: ReturnType<typeof createClient>;
let platformDb: ReturnType<typeof createPlatformDb>;
let provisioner: ReturnType<typeof createLocalFileTenantProvisioner>;
let cache: ReturnType<typeof createTenantClientCache>;

function wipe() {
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function depsFor(tenantId: string): Promise<KernelDeps> {
  const db = await cache.getDb(platformDb, tenantId);
  return { db, getTenantId: () => tenantId };
}

beforeAll(async () => {
  wipe();
  platformClient = createClient({ url: `file:${PLATFORM_DB}` });
  await applyPlatformSchema(platformClient);
  platformDb = createPlatformDb(platformClient);
  provisioner = createLocalFileTenantProvisioner({ rootDir: TENANTS_DIR });
  cache = createTenantClientCache({ maxEntries: 8 });
});

beforeEach(async () => {
  cache.clear();
  await platformClient.execute("DELETE FROM tenant_directory");
  for (const f of fs.readdirSync(TENANTS_DIR)) {
    fs.unlinkSync(path.join(TENANTS_DIR, f));
  }
});

afterAll(() => {
  cache.clear();
  platformClient.close();
  wipe();
});

describe("F0 properties", () => {
  test("1 — Tenant A nunca consulta dados do Tenant B", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    await provisionTenant({ platformDb, provisioner }, { tenantId: "B" });
    const depsA = await depsFor("A");
    const depsB = await depsFor("B");
    await createPersonRepo(depsA.db).insert({
      id: "person-a",
      name: "Alice",
      email: "a@t",
      createdAt: new Date(),
    });
    const inB = await createPersonRepo(depsB.db).findById("person-a");
    expect(inB).toBeNull();
    const personsB = await depsB.db.select().from(persons);
    expect(personsB.length).toBe(0);
  });

  test("2 — Membership revogada perde autorização (já coberto; revalida use case)", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    // seed Admin actor as person only for createdBy
    const created = await createMembership(deps, {
      tenantId: "A",
      roleCode: "Owner",
      person: { name: "Owner", email: "owner@t" },
      actor: { personId: null, userId: null, requestId: "r2" },
    });
    expect(created.membership.status).toBe("active");
    const revoked = await revokeMembership(deps, {
      membershipId: created.membership.id,
      tenantId: "A",
      actor: { personId: null, userId: null, requestId: "r2b" },
    });
    expect(revoked.status).toBe("revoked");
  });

  test("3 — mutation Membership produz AuditEvent + DomainEvent", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    const created = await createMembership(deps, {
      tenantId: "A",
      roleCode: "Fiscalizacao",
      person: { name: "F", email: "f@t" },
      actor: { personId: null, userId: null, requestId: "r3" },
    });
    const audits = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, created.membership.id));
    expect(audits.some((a) => a.type === "membership.created")).toBe(true);
    const events = await deps.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.membership.id));
    expect(events.some((e) => e.type === "MembershipCreated")).toBe(true);
  });

  test("4 — job duplicado (retry) não produz efeito duplicado", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    const key = "notify:membership:m-dup:created";
    await enqueueOutboxJob(deps, {
      tenantId: "A",
      jobType: OUTBOX_JOB_TYPES.notifyMembershipCreated,
      idempotencyKey: key,
      payload: { email: "dup@t", membershipId: "m-dup" },
    });
    await enqueueOutboxJob(deps, {
      tenantId: "A",
      jobType: OUTBOX_JOB_TYPES.notifyMembershipCreated,
      idempotencyKey: key,
      payload: { email: "dup@t", membershipId: "m-dup" },
    });
    const jobs = await deps.db.select().from(outboxJobs);
    expect(jobs.length).toBe(1);

    await processOutbox(deps);
    await processOutbox(deps);
    const deliveries = await deps.db.select().from(notificationDeliveries);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("attempted");
  });

  test("5 — upload repetido do mesmo hash não corrompe estado", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    const hash = "a".repeat(64);
    const first = await registerContentUpload(deps, {
      tenantId: "A",
      contentHash: hash,
      filename: "a.pdf",
      byteSize: 10,
    });
    const second = await registerContentUpload(deps, {
      tenantId: "A",
      contentHash: hash,
      filename: "a-renamed.pdf",
      byteSize: 99,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.upload.id).toBe(first.upload.id);
    expect(second.upload.byteSize).toBe(10);
    const rows = await deps.db.select().from(contentUploads);
    expect(rows.length).toBe(1);
  });

  test("6 — migration N tenants reporta falhas individualmente", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "ok-tenant" });
    await provisionTenant({ platformDb, provisioner }, { tenantId: "bad-tenant" });
    // Corrupt bad tenant path
    const badPath = path.join(TENANTS_DIR, "bad-tenant.db");
    fs.writeFileSync(badPath, "not-a-sqlite-db");

    const result = await migrateAllTenants(platformDb, {
      applySchema: async (client) => {
        // Probe: SELECT on roles — corrupt file fails
        await client.execute("SELECT count(*) AS c FROM roles");
        await applyDomainKernelSchema(client);
      },
    });
    expect(result.okCount).toBe(1);
    expect(result.failCount).toBe(1);
    const failed = result.results.find((r) => !r.ok);
    expect(failed?.tenantId).toBe("bad-tenant");
    expect(failed?.error).toBeTruthy();
  });

  test("7 — backup e restore de um tenant", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    await createPersonRepo(deps.db).insert({
      id: "p-backup",
      name: "Backup",
      email: "bak@t",
      createdAt: new Date(),
    });
    cache.clear();
    const { backupPath } = await backupTenantDatabase(platformDb, "A", BACKUP_DIR);
    expect(fs.existsSync(backupPath)).toBe(true);

    // Destroy live DB content
    const live = path.join(TENANTS_DIR, "A.db");
    fs.writeFileSync(live, "");
    const { restoredPath } = await restoreTenantDatabase(platformDb, "A", backupPath);
    expect(restoredPath).toBe(live);

    const client = createClient({ url: `file:${live}` });
    const rows = await client.execute("SELECT email FROM persons WHERE id = 'p-backup'");
    expect(String(rows.rows[0]?.email)).toBe("bak@t");
    client.close();
  });

  test("8 — secrets nunca aparecem em redactSecrets", () => {
    const redacted = redactSecrets({
      authorization: "Bearer super-secret-token",
      url: "https://x/?code=oauth-code&ok=1",
      nested: { DATABASE_AUTH_TOKEN: "turso-token", safe: "ok" },
    }) as Record<string, unknown>;
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(String(redacted.url)).toContain("[REDACTED]");
    expect(String(redacted.url)).not.toContain("oauth-code");
    expect((redacted.nested as Record<string, unknown>).DATABASE_AUTH_TOKEN).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).safe).toBe("ok");
  });

  test("9 — tenant inválido falha fechado (403)", async () => {
    await expect(cache.getDb(platformDb, "missing")).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(cache.getDb(platformDb, "")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  test("10 — efeito async observável: outbox status + notification delivery + audit", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    const created = await createMembership(deps, {
      tenantId: "A",
      roleCode: "Owner",
      person: { name: "Obs", email: "obs@t" },
      actor: { personId: null, userId: null, requestId: "r10", source: "test" },
    });
    const job = await createOutboxRepo(deps.db).findByIdempotency(
      "A",
      `notify:membership:${created.membership.id}:created`,
    );
    expect(job?.status).toBe(OUTBOX_STATUS.completed);
    const deliveries = await deps.db.select().from(notificationDeliveries);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.destination).toBe("obs@t");
    const notifAudit = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.type, "notification.email.attempted"));
    expect(notifAudit.length).toBe(1);
  });

  test("Policy Engine esqueleto existe na BD tenant", async () => {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "A" });
    const deps = await depsFor("A");
    await deps.db.insert(policies).values({
      id: crypto.randomUUID(),
      tenantId: "A",
      kind: "placeholder",
      code: "f0-skeleton",
      version: 1,
      bodyJson: null,
      effectiveFrom: new Date(),
      createdAt: new Date(),
    });
    const rows = await deps.db.select().from(policies);
    expect(rows.length).toBe(1);
  });
});
