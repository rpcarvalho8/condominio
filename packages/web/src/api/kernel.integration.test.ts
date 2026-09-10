/**
 * Domain Kernel v0.1 — CreateMembership / revoke + middleware Membership.
 *
 * Propriedades F0-A:
 * - Membership revogada → 403 no path novo
 * - Sem membership/tenant context → 403 (mesmo com 1 tenant)
 * - user.role legado NÃO autoriza o path kernel
 * - AuditEvent completo em create/revoke
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import {
  auditEvents,
  memberships,
  persons,
  roles,
} from "./database/schema";
import { createMembership } from "./application/identity/create-membership";
import { revokeMembership } from "./application/identity/revoke-membership";
import { AUDIT_TYPES } from "./domain/audit";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import { createAuditEventRepo } from "./infra/repos/audit-event-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createKernelRoutes } from "./routes/kernel";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-kernel.db");
const DB_URL = `file:${DB_PATH}`;

const TENANT_A = "tenant-A-nif";
const TENANT_B = "tenant-B-nif";

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let currentUser: KernelAuthUser | null = null;
let tenantIdOverride: string = TENANT_A;
let app: Hono;

const schema = { persons, memberships, roles, auditEvents };

function buildApp() {
  return new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/kernel", createKernelRoutes(deps));
}

async function seedAdmin(userId = "user-admin") {
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId,
    name: "Admin Kernel",
    email: `${userId}@example.test`,
    createdAt: new Date(),
  });
  const membership = await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId: TENANT_A,
    roleCode: "Admin",
    createdAt: new Date(),
  });
  return { person, membership, userId };
}

beforeAll(async () => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  client = createClient({ url: DB_URL });
  await applyDomainKernelSchema(client);
  const db = drizzle(client, { schema });
  deps = {
    db: db as KernelDeps["db"],
    getTenantId: () => tenantIdOverride,
  };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  tenantIdOverride = TENANT_A;
  await client.execute("DELETE FROM audit_events");
  await client.execute("DELETE FROM memberships");
  await client.execute("DELETE FROM persons");
});

afterAll(() => {
  client.close();
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

describe("GET /kernel/me — fail closed", () => {
  test("sem sessão → 401", async () => {
    currentUser = null;
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(401);
  });

  test("user.role=admin legado sem Membership → 403 (mesmo com 1 tenant)", async () => {
    currentUser = { id: "legacy-admin", role: "admin", email: "legacy@test", name: "Legacy" };
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(403);
  });

  test("Person sem Membership activo no tenant → 403", async () => {
    const personRepo = createPersonRepo(deps.db);
    await personRepo.insert({
      id: crypto.randomUUID(),
      userId: "user-orphan",
      name: "Orphan",
      email: "orphan@test",
      createdAt: new Date(),
    });
    currentUser = { id: "user-orphan", role: "admin" };
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(403);
  });

  test("tenant context vazio → 403 mesmo com Membership activo", async () => {
    const admin = await seedAdmin("user-no-tenant");
    currentUser = { id: admin.userId, role: "condómino" };
    tenantIdOverride = "";
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(403);
  });

  test("Membership doutro tenant → 403", async () => {
    const admin = await seedAdmin("user-wrong-tenant");
    currentUser = { id: admin.userId, role: "admin" };
    tenantIdOverride = TENANT_B;
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(403);
  });

  test("Membership activa → 200 com Person + roles kernel", async () => {
    const admin = await seedAdmin("user-ok");
    currentUser = { id: admin.userId, role: "condómino" };
    const res = await app.request("/kernel/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.person.id).toBe(admin.person.id);
    expect(body.memberships[0].roleCode).toBe("Admin");
    expect(body.memberships[0].status).toBe("active");
  });
});

describe("Membership revogada perde autorização de imediato", () => {
  test("após revoke, GET /kernel/me → 403", async () => {
    const admin = await seedAdmin("user-revoke");
    currentUser = { id: admin.userId, role: "admin" };

    const before = await app.request("/kernel/me");
    expect(before.status).toBe(200);

    const revoke = await app.request(`/kernel/memberships/${admin.membership.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-revoke-1" },
      body: JSON.stringify({ reason: "teste_revogacao" }),
    });
    expect(revoke.status).toBe(200);

    const after = await app.request("/kernel/me");
    expect(after.status).toBe(403);
  });
});

describe("CreateMembership + AuditEvent", () => {
  test("POST cria Membership, emite AuditEvent completo, Scope nullable", async () => {
    const admin = await seedAdmin("user-create");
    currentUser = { id: admin.userId };

    const res = await app.request("/kernel/memberships", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-create-1" },
      body: JSON.stringify({
        roleCode: "Owner",
        scope: null,
        reason: "onboarding_fracao",
        person: { name: "Maria Owner", email: "maria@test", nif: "123456789" },
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.membership.roleCode).toBe("Owner");
    expect(created.membership.scope).toBeNull();
    expect(created.membership.status).toBe("active");
    expect(created.person.email).toBe("maria@test");

    const auditRepo = createAuditEventRepo(deps.db);
    const events = await auditRepo.listByEntity("membership", created.membership.id);
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.type).toBe(AUDIT_TYPES.membershipCreated);
    expect(event.actorPersonId).toBe(admin.person.id);
    expect(event.actorUserId).toBe(admin.userId);
    expect(event.reason).toBe("onboarding_fracao");
    expect(event.source).toBe("http");
    expect(event.requestId).toBe("req-create-1");
    expect(event.before).toBeNull();
    expect(event.after?.roleCode).toBe("Owner");
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  test("revoke emite AuditEvent with before/after", async () => {
    const admin = await seedAdmin("user-audit-revoke");
    currentUser = { id: admin.userId };

    const created = await createMembership(deps, {
      tenantId: TENANT_A,
      roleCode: "Fiscalizacao",
      person: { name: "Fiscal", email: "fiscal@test" },
      actor: {
        personId: admin.person.id,
        userId: admin.userId,
        source: "application",
        requestId: "req-uc-create",
      },
    });

    const revoked = await revokeMembership(deps, {
      membershipId: created.membership.id,
      tenantId: TENANT_A,
      reason: "left_building",
      actor: {
        personId: admin.person.id,
        userId: admin.userId,
        source: "application",
        requestId: "req-uc-revoke",
      },
    });
    expect(revoked.status).toBe("revoked");

    const auditRepo = createAuditEventRepo(deps.db);
    const events = await auditRepo.listByEntity("membership", created.membership.id);
    expect(events.map((e) => e.type).sort()).toEqual([
      AUDIT_TYPES.membershipCreated,
      AUDIT_TYPES.membershipRevoked,
    ].sort());
    const revokeEvent = events.find((e) => e.type === AUDIT_TYPES.membershipRevoked)!;
    expect(revokeEvent.before?.status).toBe("active");
    expect(revokeEvent.after?.status).toBe("revoked");
    expect(revokeEvent.reason).toBe("left_building");
    expect(revokeEvent.source).toBe("application");
    expect(revokeEvent.requestId).toBe("req-uc-revoke");
    expect(revokeEvent.actorPersonId).toBe(admin.person.id);
  });

  test("Fiscalizacao não pode criar Memberships", async () => {
    const personRepo = createPersonRepo(deps.db);
    const membershipRepo = createMembershipRepo(deps.db);
    const person = await personRepo.insert({
      id: crypto.randomUUID(),
      userId: "user-fiscal",
      name: "Fiscal",
      email: "fiscal-only@test",
      createdAt: new Date(),
    });
    await membershipRepo.insert({
      id: crypto.randomUUID(),
      personId: person.id,
      tenantId: TENANT_A,
      roleCode: "Fiscalizacao",
      createdAt: new Date(),
    });
    currentUser = { id: "user-fiscal" };
    const res = await app.request("/kernel/memberships", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roleCode: "Owner",
        person: { name: "X", email: "x@test" },
      }),
    });
    expect(res.status).toBe(403);
  });

  test("seed inclui os 6 roles LUMEN", async () => {
    const rows = await client.execute("SELECT code FROM roles ORDER BY code");
    const codes = rows.rows.map((r) => String(r.code));
    expect(codes).toEqual([
      "Admin",
      "CoOwner",
      "Fiscalizacao",
      "Owner",
      "PlatformAdmin",
      "Proxy",
    ]);
  });
});
