/**
 * F0-B TenantDirectory — provisionamento idempotente + isolamento de BD.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import {
  auditEvents,
  memberships,
  persons,
  roles,
} from "./database/schema";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyPlatformSchema } from "./platform/apply-schema";
import { createPlatformDb } from "./platform/database";
import { createLocalFileTenantProvisioner } from "./infra/tenant-db-provisioner";
import {
  provisionTenant,
  requireActiveTenant,
} from "./application/platform/provision-tenant";
import { createTenantDirectoryRepo } from "./infra/repos/tenant-directory-repo";
import { DomainError } from "./domain/errors";
import { KERNEL_SCHEMA_VERSION, TENANT_STATUS } from "./domain/tenant-directory";
import type { KernelDeps } from "./infra/kernel-deps";
import { createPersonRepo } from "./infra/repos/person-repo";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createKernelRoutes } from "./routes/kernel";
import { createPlatformRoutes } from "./routes/platform";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";

const ROOT = path.join(import.meta.dir, "..", "..", ".tmp-test-platform");
const PLATFORM_DB = path.join(ROOT, "platform.db");
const TENANTS_DIR = path.join(ROOT, "tenants");
const KERNEL_DB = path.join(ROOT, "kernel-auth.db");

let platformClient: ReturnType<typeof createClient>;
let platformDb: ReturnType<typeof createPlatformDb>;
let provisioner: ReturnType<typeof createLocalFileTenantProvisioner>;
let kernelClient: ReturnType<typeof createClient>;
let kernelDeps: KernelDeps;
let currentUser: KernelAuthUser | null = null;
let tenantIdOverride = "tenant-auth";
let app: Hono;

const schema = { persons, memberships, roles, auditEvents };

function wipeDir(dir: string) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

beforeAll(async () => {
  wipeDir(ROOT);
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  platformClient = createClient({ url: `file:${PLATFORM_DB}` });
  await applyPlatformSchema(platformClient);
  platformDb = createPlatformDb(platformClient);
  provisioner = createLocalFileTenantProvisioner({ rootDir: TENANTS_DIR });

  kernelClient = createClient({ url: `file:${KERNEL_DB}` });
  await applyDomainKernelSchema(kernelClient);
  const kernelDb = drizzle(kernelClient, { schema });
  kernelDeps = {
    db: kernelDb as KernelDeps["db"],
    getTenantId: () => tenantIdOverride,
    assertTenantActive: async (tenantId) => {
      await requireActiveTenant(platformDb, tenantId);
    },
  };

  app = new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/kernel", createKernelRoutes(kernelDeps))
    .route(
      "/platform",
      createPlatformRoutes({
        kernel: kernelDeps,
        platformDb,
        provisioner,
      }),
    );
});

beforeEach(async () => {
  currentUser = null;
  tenantIdOverride = "tenant-auth";
  await platformClient.execute("DELETE FROM tenant_directory");
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  for (const f of fs.readdirSync(TENANTS_DIR)) {
    fs.unlinkSync(path.join(TENANTS_DIR, f));
  }
  await kernelClient.execute("DELETE FROM memberships");
  await kernelClient.execute("DELETE FROM persons");
});

afterAll(() => {
  platformClient.close();
  kernelClient.close();
  wipeDir(ROOT);
});

describe("provisionTenant — idempotente + 2.º DB", () => {
  test("primeira chamada cria entry activa com schema kernel", async () => {
    const result = await provisionTenant(
      { platformDb, provisioner },
      { tenantId: "condo-A", region: "eu", plan: "pilot" },
    );
    expect(result.created).toBe(true);
    expect(result.entry.tenantId).toBe("condo-A");
    expect(result.entry.status).toBe(TENANT_STATUS.active);
    expect(result.entry.schemaVersion).toBe(KERNEL_SCHEMA_VERSION);
    expect(result.entry.dbRef.startsWith("file:")).toBe(true);
    expect(result.entry.migrationStatus).toBe("current");
    expect(fs.existsSync(result.entry.dbRef.replace(/^file:/, ""))).toBe(true);

    const tenantClient = createClient({ url: result.entry.dbRef });
    const roles = await tenantClient.execute("SELECT code FROM roles ORDER BY code");
    expect(roles.rows.map((r) => r.code)).toContain("Fiscalizacao");
    tenantClient.close();
  });

  test("segunda chamada com o mesmo tenantId NÃO cria outra BD", async () => {
    const first = await provisionTenant(
      { platformDb, provisioner },
      { tenantId: "condo-A" },
    );
    const second = await provisionTenant(
      { platformDb, provisioner },
      { tenantId: "condo-A" },
    );
    expect(second.created).toBe(false);
    expect(second.entry.dbRef).toBe(first.entry.dbRef);
    const files = fs.readdirSync(TENANTS_DIR).filter((f) => f.endsWith(".db"));
    expect(files).toEqual(["condo-A.db"]);
  });

  test("segundo tenant recebe BD distinta — isolamento", async () => {
    const a = await provisionTenant({ platformDb, provisioner }, { tenantId: "condo-A" });
    const b = await provisionTenant({ platformDb, provisioner }, { tenantId: "condo-B" });
    expect(a.entry.dbRef).not.toBe(b.entry.dbRef);

    const clientA = createClient({ url: a.entry.dbRef });
    const clientB = createClient({ url: b.entry.dbRef });
    await clientA.execute(
      `INSERT INTO persons (id, name, email, created_at, updated_at) VALUES ('p1','A','a@t',1,1)`,
    );
    const inA = await clientA.execute("SELECT count(*) as c FROM persons");
    const inB = await clientB.execute("SELECT count(*) as c FROM persons");
    expect(Number(inA.rows[0]!.c)).toBe(1);
    expect(Number(inB.rows[0]!.c)).toBe(0);
    clientA.close();
    clientB.close();

    const listed = await createTenantDirectoryRepo(platformDb).list();
    expect(listed.map((t) => t.tenantId).sort()).toEqual(["condo-A", "condo-B"]);
  });

  test("tenant desconhecido / inactivo → 403 via requireActiveTenant", async () => {
    await expect(requireActiveTenant(platformDb, "missing")).rejects.toBeInstanceOf(
      DomainError,
    );
    await provisionTenant({ platformDb, provisioner }, { tenantId: "condo-X" });
    await createTenantDirectoryRepo(platformDb).update("condo-X", {
      status: TENANT_STATUS.suspended,
    });
    await expect(requireActiveTenant(platformDb, "condo-X")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });
});

describe("HTTP /platform + /kernel fail closed com directory", () => {
  async function seedPlatformAdmin() {
    await provisionTenant({ platformDb, provisioner }, { tenantId: "tenant-auth" });
    const personRepo = createPersonRepo(kernelDeps.db);
    const membershipRepo = createMembershipRepo(kernelDeps.db);
    const person = await personRepo.insert({
      id: crypto.randomUUID(),
      userId: "user-pa",
      name: "Platform Admin",
      email: "pa@test",
      createdAt: new Date(),
    });
    await membershipRepo.insert({
      id: crypto.randomUUID(),
      personId: person.id,
      tenantId: "tenant-auth",
      roleCode: "PlatformAdmin",
      createdAt: new Date(),
    });
    currentUser = { id: "user-pa" };
    return person;
  }

  test("GET /kernel/me sem tenant no directory → 403", async () => {
    const personRepo = createPersonRepo(kernelDeps.db);
    const membershipRepo = createMembershipRepo(kernelDeps.db);
    const person = await personRepo.insert({
      id: crypto.randomUUID(),
      userId: "user-no-dir",
      name: "X",
      email: "x@test",
      createdAt: new Date(),
    });
    await membershipRepo.insert({
      id: crypto.randomUUID(),
      personId: person.id,
      tenantId: "tenant-auth",
      roleCode: "Admin",
      createdAt: new Date(),
    });
    currentUser = { id: "user-no-dir" };
    // tenant-auth ainda não está no directory
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(403);
  });

  test("POST /platform/tenants idempotente via Membership PlatformAdmin", async () => {
    await seedPlatformAdmin();
    const first = await app.request("/platform/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "condo-http", plan: "test" }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("/platform/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "condo-http", plan: "test" }),
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.created).toBe(false);
    expect(body.entry.tenantId).toBe("condo-http");
  });

  test("user.role legado sem Membership → 403 em /platform", async () => {
    currentUser = { id: "legacy", role: "admin" };
    const res = await app.request("/platform/tenants");
    expect(res.status).toBe(403);
  });
});
