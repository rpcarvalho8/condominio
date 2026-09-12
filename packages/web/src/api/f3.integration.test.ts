/**
 * F3 — Invitation (Essencial): individual/lote, revogação, expiry,
 * verificação de contacto → Person + Membership. Sem QR físico.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./database/schema";
import {
  confirmContactLines,
  confirmFracaoLines,
  extractDocumentLines,
  listConstitutionFracoes,
  registerIngestDocument,
} from "./application/constitution/f1-constitution";
import { acceptInvitation } from "./application/invitation/accept-invitation";
import { createInvitation, createInvitationLote } from "./application/invitation/create-invitation";
import { readContactVerificationFromOutbox, resetInvitationSecretHarness } from "./application/invitation/invitation-secrets";
import { F3_PUBLIC_RATE_MAX, resetF3PublicRateLimit } from "./application/invitation/public-rate-limit";
import { listInvitations } from "./application/invitation/list-invitations";
import { revokeInvitation } from "./application/invitation/revoke-invitation";
import {
  confirmContactVerification,
  requestContactVerification,
} from "./application/invitation/verify-contact";
import { enqueueOutboxJob } from "./application/events/emit";
import { processOutbox } from "./application/jobs/process-outbox";
import { INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import { AUDIT_TYPES } from "./domain/audit";
import { DomainError } from "./domain/errors";
import { hashOpaqueSecret, INVITATION_MAX_TTL_MS, INVITATION_STATUS } from "./domain/invitation";
import { OUTBOX_JOB_TYPES } from "./domain/outbox";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createInvitationRepo } from "./infra/repos/invitation-repo";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF3Routes } from "./routes/f3";
import { createKernelRoutes } from "./routes/kernel";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f3.db");
const TENANT_A = "tenant-f3-a";
const TENANT_B = "tenant-f3-b";

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let currentUser: KernelAuthUser | null = null;
let tenantIdOverride = TENANT_A;
let app: Hono;

async function seedFracoes(tenantId: string, codigos: string[] = ["A", "B"]) {
  const doc = await registerIngestDocument(deps, {
    tenantId,
    kind: INGEST_DOCUMENT_KINDS.regulamento,
    filename: "regulamento.pdf",
  });
  const perm = Math.floor(1000 / codigos.length);
  const remainder = 1000 - perm * (codigos.length - 1);
  const { lines } = await extractDocumentLines(deps, {
    tenantId,
    documentId: doc.id,
    extraction: {
      lines: codigos.map((codigo, i) => ({
        kind: "fracao",
        payload: { codigo, permilagem: i === 0 ? remainder : perm },
        sourceExcerpt: `${codigo} — permilagem`,
      })),
    },
  });
  await confirmFracaoLines(deps, {
    tenantId,
    documentId: doc.id,
    confirmations: lines.map((l) => ({ lineId: l.id })),
  });
  return listConstitutionFracoes(deps, { tenantId });
}

async function seedActor(opts: {
  userId: string;
  roleCode: string;
  name: string;
  email: string;
  tenantId?: string;
}) {
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: opts.userId,
    name: opts.name,
    email: opts.email,
    createdAt: new Date(),
  });
  await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId: opts.tenantId ?? TENANT_A,
    roleCode: opts.roleCode,
    createdAt: new Date(),
  });
  return person;
}

function buildApp() {
  return new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/f3", createF3Routes(deps))
    .route("/kernel", createKernelRoutes(deps));
}

beforeAll(async () => {
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  client = createClient({ url: `file:${DB_PATH}` });
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
  const db = drizzle(client, { schema });
  deps = { db, getTenantId: () => tenantIdOverride };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  tenantIdOverride = TENANT_A;
  deps.now = undefined;
  resetInvitationSecretHarness();
  resetF3PublicRateLimit();
  for (const table of [
    "invitations",
    "memberships",
    "persons",
    "owner_contact_drafts",
    "constitution_fracoes",
    "extract_lines",
    "ingest_documents",
    "outbox_jobs",
    "notification_deliveries",
    "audit_events",
    "domain_events",
  ]) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

afterAll(() => {
  try {
    client.close();
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
});

describe("F3 Invitation — núcleo", () => {
  test("convite individual: create + outbox idempotente + AuditEvent", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "maria@condo.test",
      personName: "Maria Owner",
      actor: { personId: null, userId: null, requestId: "inv-1" },
    });
    expect(created.invitation.status).toBe(INVITATION_STATUS.pending);
    expect(created.token).not.toContain(created.invitation.id);
    expect(created.invitation.contactoMasked).toBe("m***@condo.test");

    const stored = await createInvitationRepo(deps.db).findById(created.invitation.id);
    expect(stored?.tokenHash).toBe(hashOpaqueSecret(created.token));
    expect(stored?.tokenHash).not.toBe(created.token);

    const audits = await deps.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.invitation.id));
    expect(audits.some((a) => a.type === AUDIT_TYPES.invitationCreated)).toBe(true);

    const jobs = await deps.db.select().from(schema.outboxJobs);
    const inviteJobs = jobs.filter((j) => j.jobType === OUTBOX_JOB_TYPES.notifyInvitationCreated);
    expect(inviteJobs).toHaveLength(1);
    expect(inviteJobs[0]!.status).toBe("completed");
    expect(inviteJobs[0]!.idempotencyKey).toBe(`notify:invitation:${created.invitation.id}:created`);
    const createdPayload = JSON.parse(inviteJobs[0]!.payloadJson) as { token?: string };
    expect(createdPayload.token).toBe("[REDACTED]");

    const again = await enqueueOutboxJob(deps, {
      tenantId: TENANT_A,
      jobType: OUTBOX_JOB_TYPES.notifyInvitationCreated,
      idempotencyKey: `notify:invitation:${created.invitation.id}:created`,
      payload: { invitationId: created.invitation.id },
    });
    expect(again.created).toBe(false);
    await processOutbox(deps);
    const deliveries = await deps.db.select().from(schema.notificationDeliveries);
    expect(deliveries.filter((d) => d.template === "invitation_created")).toHaveLength(1);
  });

  test("lote partilha lote_id; revogação impede aceite", async () => {
    const [a, b] = await seedFracoes(TENANT_A, ["A", "B"]);
    const lote = await createInvitationLote(deps, {
      tenantId: TENANT_A,
      items: [
        { fracaoId: a.id, contacto: "a@condo.test", personName: "A" },
        { fracaoId: b.id, contacto: "b@condo.test", personName: "B" },
      ],
      actor: { personId: null, userId: null, requestId: "lote-1" },
    });
    expect(lote.invitations).toHaveLength(2);
    expect(lote.errors).toHaveLength(0);
    expect(lote.invitations[0]!.invitation.loteId).toBe(lote.loteId);
    expect(lote.invitations[1]!.invitation.loteId).toBe(lote.loteId);

    const listed = await listInvitations(deps, { tenantId: TENANT_A, loteId: lote.loteId });
    expect(listed).toHaveLength(2);

    const first = lote.invitations[0]!;
    await revokeInvitation(deps, {
      invitationId: first.invitation.id,
      tenantId: TENANT_A,
      actor: { personId: null, userId: null, requestId: "rev-1" },
    });
    await expect(
      requestContactVerification(deps, { token: first.token }),
    ).rejects.toMatchObject({ code: "invitation_revoked" });
  });

  test("expiry impede verificação e aceite", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "expira@condo.test",
      expiresInMs: 1_000,
      actor: { personId: null, userId: null },
    });
    deps.now = () => new Date(Date.now() + 60_000);
    await expect(requestContactVerification(deps, { token: created.token })).rejects.toMatchObject({
      code: "invitation_expired",
    });
    await expect(acceptInvitation(deps, { token: created.token })).rejects.toMatchObject({
      code: "invitation_expired",
    });
    const listed = await listInvitations(deps, { tenantId: TENANT_A });
    expect(listed[0]!.status).toBe(INVITATION_STATUS.expired);
  });

  test("verificação de contacto é obrigatória antes de Membership", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "joao@condo.test",
      personName: "João",
      actor: { personId: null, userId: null, requestId: "ver-1" },
    });

    await expect(
      acceptInvitation(deps, { token: created.token, userId: "user-joao", name: "João" }),
    ).rejects.toMatchObject({ code: "contact_not_verified" });

    const issued = await requestContactVerification(deps, { token: created.token });
    expect("verificationToken" in issued).toBe(false);
    expect("code" in issued).toBe(false);

    const secrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
    expect(secrets.code).toMatch(/^\d{6}$/);
    expect(secrets.verificationToken.length).toBeGreaterThan(20);

    const jobs = await deps.db
      .select()
      .from(schema.outboxJobs)
      .where(eq(schema.outboxJobs.jobType, OUTBOX_JOB_TYPES.notifyInvitationVerify));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(jobs[0]!.payloadJson) as { code?: string; verificationToken?: string };
    expect(payload.code).toBe("[REDACTED]");
    expect(payload.verificationToken).toBe("[REDACTED]");

    await expect(
      confirmContactVerification(deps, { token: created.token, code: "000000" }),
    ).rejects.toBeInstanceOf(DomainError);

    const confirmed = await confirmContactVerification(deps, {
      token: created.token,
      code: secrets.code,
    });
    expect(confirmed.contactVerified).toBe(true);

    const accepted = await acceptInvitation(deps, {
      token: created.token,
      userId: "user-joao",
      name: "João Silva",
    });
    expect(accepted.membershipId).toBeTruthy();

    const membership = await createMembershipRepo(deps.db).findById(accepted.membershipId);
    expect(membership?.roleCode).toBe("Owner");
    expect(membership?.fracaoId).toBe(fracao.id);
    expect(membership?.tenantId).toBe(TENANT_A);
    expect(membership?.status).toBe("active");

    const person = await createPersonRepo(deps.db).findById(accepted.personId);
    expect(person?.email).toBe("joao@condo.test");
    expect(person?.userId).toBe("user-joao");

    await expect(
      acceptInvitation(deps, { token: created.token, userId: "user-joao" }),
    ).rejects.toMatchObject({ code: "invitation_used" });
  });

  test("aceitação alinha sessão F0 — GET /kernel/me com Membership", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "ana@condo.test",
      actor: { personId: null, userId: null },
    });
    await requestContactVerification(deps, { token: created.token });
    const anaSecrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
    await confirmContactVerification(deps, {
      token: created.token,
      verificationToken: anaSecrets.verificationToken,
    });
    await acceptInvitation(deps, {
      token: created.token,
      userId: "user-ana",
      name: "Ana",
    });

    currentUser = { id: "user-ana", email: "ana@condo.test", name: "Ana" };
    const me = await app.request("/kernel/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      tenantId: string;
      person: { email: string };
      memberships: Array<{ roleCode: string; fracaoId: string }>;
    };
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.person.email).toBe("ana@condo.test");
    expect(body.memberships[0]!.roleCode).toBe("Owner");
    expect(body.memberships[0]!.fracaoId).toBe(fracao.id);
  });

  test("isolamento multi-tenant: listar A não vê convites de B", async () => {
    const [fracaoA] = await seedFracoes(TENANT_A, ["A"]);
    const [fracaoB] = await seedFracoes(TENANT_B, ["A"]);
    await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracaoA.id,
      contacto: "a@condo.test",
      actor: { personId: null, userId: null },
    });
    await createInvitation(deps, {
      tenantId: TENANT_B,
      fracaoId: fracaoB.id,
      contacto: "b@condo.test",
      actor: { personId: null, userId: null },
    });
    const listA = await listInvitations(deps, { tenantId: TENANT_A });
    const listB = await listInvitations(deps, { tenantId: TENANT_B });
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]!.id).not.toBe(listB[0]!.id);
  });

  test("confirm-contactos F1 nunca cria Invitation", async () => {
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT_A,
      kind: INGEST_DOCUMENT_KINDS.contactos,
      filename: "contactos.csv",
    });
    const { lines } = await extractDocumentLines(deps, {
      tenantId: TENANT_A,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "contacto",
            payload: {
              fracaoCodigo: "A",
              personName: "Maria",
              email: "ocr@condo.test",
            },
            sourceExcerpt: "A;Maria;ocr@condo.test",
          },
        ],
      },
    });
    const confirmed = await confirmContactLines(deps, {
      tenantId: TENANT_A,
      documentId: doc.id,
      confirmations: lines.map((l) => ({ lineId: l.id })),
    });
    expect(confirmed.contacts).toHaveLength(1);
    const invitations = await createInvitationRepo(deps.db).listByTenant(TENANT_A);
    expect(invitations).toHaveLength(0);
  });

  test("double-accept race: só uma Membership e o segundo falha 409", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "race@condo.test",
      personName: "Race",
      actor: { personId: null, userId: null, requestId: "race-1" },
    });
    await requestContactVerification(deps, { token: created.token });
    const secrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
    await confirmContactVerification(deps, { token: created.token, code: secrets.code });

    const results = await Promise.allSettled([
      acceptInvitation(deps, { token: created.token, userId: "user-race-a", name: "Race A" }),
      acceptInvitation(deps, { token: created.token, userId: "user-race-b", name: "Race B" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = (failed[0] as PromiseRejectedResult).reason as DomainError;
    expect(reason).toBeInstanceOf(DomainError);
    expect(reason.httpStatus).toBe(409);

    const memberships = await deps.db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.fracaoId, fracao.id));
    expect(memberships).toHaveLength(1);

    const stored = await createInvitationRepo(deps.db).findById(created.invitation.id);
    expect(stored?.status).toBe(INVITATION_STATUS.accepted);
    expect(
      await createInvitationRepo(deps.db).markAccepted({
        id: created.invitation.id,
        usedAt: new Date(),
        acceptedPersonId: "x",
        acceptedMembershipId: "y",
      }),
    ).toBeNull();
  });

  test("lote devolve created[] e errors[] sem sucesso parcial silencioso", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const lote = await createInvitationLote(deps, {
      tenantId: TENANT_A,
      items: [
        { fracaoId: fracao.id, contacto: "ok@condo.test", personName: "Ok" },
        { fracaoId: fracao.id, contacto: "nao-e-email", personName: "Bad" },
      ],
      actor: { personId: null, userId: null, requestId: "lote-partial" },
    });
    expect(lote.created).toHaveLength(1);
    expect(lote.errors).toHaveLength(1);
    expect(lote.errors[0]!.code).toBe("invalid_contact");
    expect(lote.errors[0]!.contactoMasked).not.toContain("nao-e-email");
    expect(await createInvitationRepo(deps.db).listByTenant(TENANT_A)).toHaveLength(1);
  });

  test("revogar após aceite falha 409 (TOCTOU-safe)", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "rev@condo.test",
      actor: { personId: null, userId: null },
    });
    await requestContactVerification(deps, { token: created.token });
    const secrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
    await confirmContactVerification(deps, { token: created.token, code: secrets.code });
    await acceptInvitation(deps, { token: created.token, userId: "user-rev", name: "Rev" });
    await expect(
      revokeInvitation(deps, {
        invitationId: created.invitation.id,
        tenantId: TENANT_A,
        actor: { personId: null, userId: null },
      }),
    ).rejects.toMatchObject({ code: "invitation_used", httpStatus: 409 });
  });

  test("expiresInMs do gestor é limitado", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const before = Date.now();
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "ttl@condo.test",
      expiresInMs: INVITATION_MAX_TTL_MS + 10 * 24 * 60 * 60 * 1000,
      actor: { personId: null, userId: null },
    });
    const ttl = created.invitation.expiresAt.getTime() - before;
    expect(ttl).toBeLessThanOrEqual(INVITATION_MAX_TTL_MS + 5_000);
    expect(ttl).toBeGreaterThan(INVITATION_MAX_TTL_MS - 60_000);
  });
});

describe("F3 Invitation — AuthZ HTTP", () => {
  test("Admin cria; Owner e Fiscalizacao recebem 403; PlatformAdmin pode", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    await seedActor({
      userId: "user-admin",
      roleCode: "Admin",
      name: "Admin",
      email: "admin@condo.test",
    });
    await seedActor({
      userId: "user-owner",
      roleCode: "Owner",
      name: "Owner",
      email: "owner@condo.test",
    });
    await seedActor({
      userId: "user-fisc",
      roleCode: "Fiscalizacao",
      name: "Fisc",
      email: "fisc@condo.test",
    });
    await seedActor({
      userId: "user-platform",
      roleCode: "PlatformAdmin",
      name: "Plat",
      email: "plat@condo.test",
    });

    const payload = JSON.stringify({
      fracaoId: fracao.id,
      contacto: "novo@condo.test",
      personName: "Novo",
    });

    currentUser = { id: "user-owner", email: "owner@condo.test" };
    const ownerRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(ownerRes.status).toBe(403);

    currentUser = { id: "user-fisc", email: "fisc@condo.test" };
    const fiscRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(fiscRes.status).toBe(403);

    currentUser = { id: "user-admin", email: "admin@condo.test" };
    const adminRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "http-admin" },
      body: payload,
    });
    expect(adminRes.status).toBe(201);
    const created = (await adminRes.json()) as { invitation: { id: string }; token: string };
    expect(created.token).toBeTruthy();

    currentUser = { id: "user-platform", email: "plat@condo.test" };
    const platRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fracaoId: fracao.id,
        contacto: "outro@condo.test",
      }),
    });
    expect(platRes.status).toBe(201);

    currentUser = { id: "user-owner" };
    const listOwner = await app.request("/f3/invitations");
    expect(listOwner.status).toBe(403);
    const revokeOwner = await app.request(`/f3/invitations/${created.invitation.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(revokeOwner.status).toBe(403);

    currentUser = { id: "user-admin" };
    const listAdmin = await app.request("/f3/invitations");
    expect(listAdmin.status).toBe(200);
    const listed = (await listAdmin.json()) as { invitations: unknown[] };
    expect(listed.invitations.length).toBeGreaterThanOrEqual(2);

    const panel = await app.request("/f3/activation");
    expect(panel.status).toBe(200);
    const panelBody = (await panel.json()) as { invited: number; portalOpen: null };
    expect(panelBody.invited).toBeGreaterThanOrEqual(2);
    expect(panelBody.portalOpen).toBeNull();
  });

  test("fluxo público HTTP: verify + accept sem QR", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    await seedActor({
      userId: "user-admin-2",
      roleCode: "Admin",
      name: "Admin",
      email: "admin2@condo.test",
    });
    currentUser = { id: "user-admin-2" };
    const createdRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fracaoId: fracao.id, contacto: "http@condo.test", personName: "Http" }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { token: string; invitation: { id: string } };

    currentUser = null;
    const preview = await app.request(`/f3/public/invitations/${created.token}`);
    expect(preview.status).toBe(200);

    const qrProbe = await app.request("/f3/qr", { method: "POST" });
    expect(qrProbe.status).toBe(401);

    const reqVerify = await app.request(`/f3/public/invitations/${created.token}/verify/request`, {
      method: "POST",
    });
    expect(reqVerify.status).toBe(200);
    const verifyBody = (await reqVerify.json()) as {
      invitation: { id: string };
      verificationToken?: string;
      code?: string;
    };
    expect(verifyBody.verificationToken).toBeUndefined();
    expect(verifyBody.code).toBeUndefined();
    const httpSecrets = await readContactVerificationFromOutbox(deps, created.invitation.id);

    const confirm = await app.request(`/f3/public/invitations/${created.token}/verify/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationToken: httpSecrets.verificationToken }),
    });
    expect(confirm.status).toBe(200);

    currentUser = { id: "user-http", email: "http@condo.test", name: "Http" };
    const accept = await app.request(`/f3/public/invitations/${created.token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Http User" }),
    });
    expect(accept.status).toBe(201);
    const accepted = (await accept.json()) as { membershipId: string; tenantId: string };
    expect(accepted.tenantId).toBe(TENANT_A);

    tenantIdOverride = TENANT_A;
    const me = await app.request("/kernel/me");
    expect(me.status).toBe(200);
  });

  test("lote HTTP a partir de contactos confirmados (botão explícito)", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const doc = await registerIngestDocument(deps, {
      tenantId: TENANT_A,
      kind: INGEST_DOCUMENT_KINDS.contactos,
      filename: "contactos.csv",
    });
    const { lines } = await extractDocumentLines(deps, {
      tenantId: TENANT_A,
      documentId: doc.id,
      extraction: {
        lines: [
          {
            kind: "contacto",
            payload: {
              fracaoCodigo: "A",
              personName: "Lote Maria",
              email: "lote@condo.test",
            },
            sourceExcerpt: "A;Lote Maria;lote@condo.test",
          },
        ],
      },
    });
    const confirmed = await confirmContactLines(deps, {
      tenantId: TENANT_A,
      documentId: doc.id,
      confirmations: lines.map((l) => ({ lineId: l.id })),
    });
    expect(await createInvitationRepo(deps.db).listByTenant(TENANT_A)).toHaveLength(0);

    await seedActor({
      userId: "user-admin-lote",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-lote@condo.test",
    });
    currentUser = { id: "user-admin-lote" };
    const loteRes = await app.request("/f3/invitations/lote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactDraftIds: [confirmed.contacts[0]!.id] }),
    });
    expect(loteRes.status).toBe(201);
    const lote = (await loteRes.json()) as {
      loteId: string;
      invitations: Array<{ invitation: { fracaoId: string } }>;
    };
    expect(lote.loteId).toBeTruthy();
    expect(lote.invitations[0]!.invitation.fracaoId).toBe(fracao.id);
  });

  test("accept público ignora body.userId — só sessionUser.id", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    await seedActor({
      userId: "user-admin-uid",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-uid@condo.test",
    });
    currentUser = { id: "user-admin-uid" };
    const createdRes = await app.request("/f3/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fracaoId: fracao.id, contacto: "uid@condo.test", personName: "Uid" }),
    });
    const created = (await createdRes.json()) as { token: string; invitation: { id: string } };
    currentUser = null;
    await app.request(`/f3/public/invitations/${created.token}/verify/request`, { method: "POST" });
    const secrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
    await app.request(`/f3/public/invitations/${created.token}/verify/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: secrets.code }),
    });
    const accept = await app.request(`/f3/public/invitations/${created.token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Attacker", userId: "attacker-chosen-id" }),
    });
    expect(accept.status).toBe(201);
    const accepted = (await accept.json()) as { personId: string };
    const person = await createPersonRepo(deps.db).findById(accepted.personId);
    expect(person?.userId).not.toBe("attacker-chosen-id");
    expect(person?.userId).toBeNull();
  });

  test("rate limit IP+token nos endpoints públicos F3", async () => {
    const [fracao] = await seedFracoes(TENANT_A, ["A"]);
    const created = await createInvitation(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      contacto: "rl@condo.test",
      actor: { personId: null, userId: null },
    });
    let lastStatus = 0;
    for (let i = 0; i < F3_PUBLIC_RATE_MAX + 1; i++) {
      const res = await app.request(`/f3/public/invitations/${created.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify({ name: "Rl" }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    const body = (await (
      await app.request(`/f3/public/invitations/${created.token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: "{}",
      })
    ).json()) as { message: string };
    expect(body.message).toMatch(/Demasiados pedidos/);
  });
});
