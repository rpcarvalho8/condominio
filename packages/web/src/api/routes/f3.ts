import { Hono } from "hono";
import { acceptInvitation } from "../application/invitation/accept-invitation";
import {
  createInvitationsFromConfirmedContacts,
  getActivationPanel,
} from "../application/invitation/activation-panel";
import {
  createPortalAdminContact,
  listPortalAdminContacts,
} from "../application/portal/f3-contact-admin";
import {
  downloadPortalDocument,
  getPortalSaldo,
  listPortalDocuments,
  requestPortalAccountStatement,
} from "../application/portal/f3-portal";
import {
  createPortalTicket,
  downloadPortalTicketPhoto,
  getPortalTicket,
  listPortalTickets,
} from "../application/portal/f3-tickets";
import {
  createInvitation,
  createInvitationLote,
} from "../application/invitation/create-invitation";
import { listInvitations } from "../application/invitation/list-invitations";
import {
  assertF3PublicRateLimit,
  clientIpFromHeaders,
} from "../application/invitation/public-rate-limit";
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
  // Never log request bodies / contactos / tokens.
  console.error("[f3]", err instanceof Error ? err.name : "unknown_error");
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

function enforcePublicRateLimit(
  c: { req: { header: (name: string) => string | undefined; param: (name: string) => string } },
  action: string,
): void {
  assertF3PublicRateLimit({
    ip: clientIpFromHeaders((name) => c.req.header(name)),
    token: c.req.param("token"),
    action,
  });
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
        enforcePublicRateLimit(c, "verify-request");
        const result = await requestContactVerification(deps, {
          token: c.req.param("token"),
          requestId: requestIdFrom(c),
        });
        return c.json({ invitation: result.invitation });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/public/invitations/:token/verify/confirm", async (c) => {
      try {
        enforcePublicRateLimit(c, "verify-confirm");
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
        enforcePublicRateLimit(c, "accept");
        const body = (await c.req.json().catch(() => ({}))) as {
          name?: string;
          email?: string;
        };
        const sessionUser = c.get("user") as { id?: string; email?: string; name?: string } | null;
        const result = await acceptInvitation(deps, {
          token: c.req.param("token"),
          userId: sessionUser?.id ?? null,
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
        // `token` is returned once (never stored in plaintext). Treat as one-time.
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

  const portalRoutes = new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .get("/portal/saldo", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await getPortalSaldo(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/documents", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await listPortalDocuments(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/documents/:id/download", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await downloadPortalDocument(deps, {
          tenantId: c.get("tenantId")!,
          documentId: c.req.param("id"),
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return new Response(result.body, {
          status: 200,
          headers: {
            "Content-Type": result.contentType,
            "Content-Disposition": `attachment; filename="${result.filename}"`,
          },
        });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/portal/documents/account-statement", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const body = (await c.req.json().catch(() => ({}))) as { fracaoId?: string };
        const document = await requestPortalAccountStatement(deps, {
          tenantId: c.get("tenantId")!,
          fracaoId: body.fracaoId,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json({ document }, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/tickets", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await listPortalTickets(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/tickets/:id", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const ticket = await getPortalTicket(deps, {
          tenantId: c.get("tenantId")!,
          ticketId: c.req.param("id"),
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json({ ticket });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/tickets/:id/photos/:photoId", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await downloadPortalTicketPhoto(deps, {
          tenantId: c.get("tenantId")!,
          ticketId: c.req.param("id"),
          photoId: c.req.param("photoId"),
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        const safeName = result.filename.replace(/"/g, "");
        return new Response(result.body, {
          status: 200,
          headers: {
            "Content-Type": result.contentType,
            "Content-Disposition": `inline; filename="${safeName}"`,
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/portal/tickets", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const contentType = c.req.header("content-type") ?? "";
        let titulo = "";
        let descricao = "";
        let fracaoId: string | undefined;
        let categoria: string | undefined;
        let urgencia: string | undefined;
        const files: Array<{ filename: string; mimeType?: string | null; bytes: Uint8Array }> = [];

        if (contentType.includes("multipart/form-data")) {
          const body = await c.req.parseBody({ all: true });
          titulo = String(body.titulo ?? "");
          descricao = String(body.descricao ?? "");
          if (typeof body.fracaoId === "string") fracaoId = body.fracaoId;
          if (typeof body.categoria === "string") categoria = body.categoria;
          if (typeof body.urgencia === "string") urgencia = body.urgencia;
          const raw = body.files ?? body.file ?? body.photo ?? body.photos;
          const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
          for (const item of list) {
            if (!item || typeof item === "string") continue;
            const file = item as File;
            files.push({
              filename: file.name || "foto.jpg",
              mimeType: file.type || null,
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
          }
        } else {
          const body = (await c.req.json().catch(() => ({}))) as {
            titulo?: string;
            descricao?: string;
            fracaoId?: string;
            categoria?: string;
            urgencia?: string;
          };
          titulo = String(body.titulo ?? "");
          descricao = String(body.descricao ?? "");
          fracaoId = body.fracaoId;
          categoria = body.categoria;
          urgencia = body.urgencia;
        }

        const ticket = await createPortalTicket(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
          fracaoId,
          titulo,
          descricao,
          categoria,
          urgencia,
          files,
        });
        return c.json({ ticket }, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .get("/portal/contact-admin", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const result = await listPortalAdminContacts(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
        });
        return c.json(result);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/portal/contact-admin", async (c) => {
      try {
        const person = c.get("person");
        if (!person) return c.json({ message: "Acesso negado" }, 403);
        const body = (await c.req.json().catch(() => ({}))) as {
          subject?: string;
          body?: string;
          mensagem?: string;
          fracaoId?: string;
        };
        const contact = await createPortalAdminContact(deps, {
          tenantId: c.get("tenantId")!,
          memberships: c.get("memberships") ?? [],
          actor: { personId: person.id, userId: c.get("user")?.id ?? null, requestId: requestIdFrom(c) },
          fracaoId: body.fracaoId,
          subject: String(body.subject ?? ""),
          body: String(body.body ?? body.mensagem ?? ""),
        });
        return c.json({ contact }, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });

  return new Hono<{ Variables: KernelVariables }>()
    .route("/", publicRoutes)
    .route("/", portalRoutes)
    .route("/", managerRoutes);
}
