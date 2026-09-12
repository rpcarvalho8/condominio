import { Hono } from "hono";
import { acceptInvitation } from "../application/invitation/accept-invitation";
import {
  createInvitationsFromConfirmedContacts,
  getActivationPanel,
} from "../application/invitation/activation-panel";
import {
  createInvitation,
  createInvitationLote,
} from "../application/invitation/create-invitation";
import { listInvitations } from "../application/invitation/list-invitations";
import { revokeInvitation } from "../application/invitation/revoke-invitation";
import {
  confirmContactVerification,
  previewInvitationByToken,
  requestContactVerification,
} from "../application/invitation/verify-contact";
import { DomainError } from "../domain/errors";
import type { KernelDeps } from "../infra/kernel-deps";
import {
  createRequireActiveMembership,
  createRequireMembershipManager,
  type KernelVariables,
} from "../middleware/membership";

function requestIdFrom(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function httpError(
  err: unknown,
): { message: string; status: 400 | 403 | 404 | 409 | 410 | 429 | 500 } {
  if (err instanceof DomainError) {
    const status = err.httpStatus;
    if (
      status === 400 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 410 ||
      status === 429
    ) {
      return { message: err.message, status };
    }
  }
  console.error("[f3]", err);
  return { message: "Erro interno", status: 500 };
}

function actorFrom(c: {
  get: (k: string) => unknown;
  req: { header: (n: string) => string | undefined };
}) {
  const person = c.get("person") as { id?: string } | null;
  const user = c.get("user") as { id?: string } | null;
  return {
    personId: person?.id ?? null,
    userId: user?.id ?? null,
    source: "http" as const,
    requestId: requestIdFrom(c),
  };
}

/** F3 — Invitation + verificação de contacto. Sem QR físico (ADR-001). */
export function createF3Routes(deps: KernelDeps) {
  const requireMembership = createRequireActiveMembership(deps);
  const requireManager = createRequireMembershipManager();

  const publicRoutes = new Hono<{ Variables: KernelVariables }>()
    .get("/public/invitations/:token", async (c) => {
      try {
        const invitation = await previewInvitationByToken(deps, c.req.param("token"));
        return c.json({ invitation });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/public/invitations/:token/verify/request", async (c) => {
      try {
        const result = await requestContactVerification(deps, {
          token: c.req.param("token"),
          requestId: requestIdFrom(c),
        });
        return c.json({
          invitation: result.invitation,
          verificationToken: result.verificationToken || undefined,
        });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/public/invitations/:token/verify/confirm", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          code?: string;
          verificationToken?: string;
        };
        const invitation = await confirmContactVerification(deps, {
          token: c.req.param("token"),
          code: body.code,
          verificationToken: body.verificationToken,
          requestId: requestIdFrom(c),
        });
        return c.json({ invitation });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/public/invitations/:token/accept", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          name?: string;
          email?: string;
          userId?: string;
        };
        const sessionUser = c.get("user") as { id?: string; email?: string; name?: string } | null;
        const result = await acceptInvitation(deps, {
          token: c.req.param("token"),
          userId: sessionUser?.id ?? body.userId ?? null,
          name: body.name ?? sessionUser?.name ?? null,
          email: body.email ?? sessionUser?.email ?? null,
          requestId: requestIdFrom(c),
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });

  const managerRoutes = new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .use(requireManager)
    .get("/invitations", async (c) => {
      try {
        const loteId = c.req.query("loteId") ?? null;
        const invitations = await listInvitations(deps, {
          tenantId: c.get("tenantId")!,
          loteId,
        });
        return c.json({ invitations });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/invitations", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          fracaoId?: string;
          contacto?: string;
          canal?: string;
          personName?: string;
          roleCode?: string;
          expiresInMs?: number;
        };
        if (!body.fracaoId || !body.contacto) {
          return c.json({ message: "fracaoId e contacto são obrigatórios" }, 400);
        }
        const result = await createInvitation(deps, {
          tenantId: c.get("tenantId")!,
          fracaoId: body.fracaoId,
          contacto: body.contacto,
          canal: body.canal,
          personName: body.personName,
          roleCode: body.roleCode,
          expiresInMs: body.expiresInMs,
          actor: actorFrom(c),
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/invitations/lote", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          items?: Array<{
            fracaoId: string;
            contacto: string;
            canal?: string;
            personName?: string | null;
            roleCode?: string | null;
          }>;
          contactDraftIds?: string[];
        };
        const tenantId = c.get("tenantId")!;
        const actor = actorFrom(c);
        if (body.contactDraftIds?.length) {
          const result = await createInvitationsFromConfirmedContacts(deps, {
            tenantId,
            contactDraftIds: body.contactDraftIds,
            actor,
          });
          return c.json(result, 201);
        }
        const result = await createInvitationLote(deps, {
          tenantId,
          items: body.items ?? [],
          actor,
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/invitations/:id/revoke", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { reason?: string | null };
        const invitation = await revokeInvitation(deps, {
          invitationId: c.req.param("id"),
          tenantId: c.get("tenantId")!,
          reason: body.reason ?? null,
          actor: actorFrom(c),
        });
        return c.json({ invitation });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/activation", async (c) => {
      try {
        const panel = await getActivationPanel(deps, { tenantId: c.get("tenantId")! });
        return c.json(panel);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });

  return new Hono<{ Variables: KernelVariables }>()
    .route("/", publicRoutes)
    .route("/", managerRoutes);
}
