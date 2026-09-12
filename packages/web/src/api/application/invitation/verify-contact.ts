import { AUDIT_TYPES } from "../../domain/audit";
import { DomainError } from "../../domain/errors";
import {
  assertUsableInvitation,
  generateOpaqueToken,
  generateVerificationCode,
  hashOpaqueSecret,
  MAX_VERIFICATION_ATTEMPTS,
  MAX_VERIFICATION_REQUESTS,
  toPublicInvitation,
  VERIFICATION_CODE_TTL_MS,
  type InvitationPublicView,
} from "../../domain/invitation";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";
import { enqueueOutboxJob } from "../events/emit";
import { processOutbox } from "../jobs/process-outbox";

async function loadByToken(deps: KernelDeps, token: string) {
  if (!token?.trim()) {
    throw new DomainError("token_required", "Token do convite é obrigatório", 400);
  }
  const invitation = await createInvitationRepo(deps.db).findByTokenHash(hashOpaqueSecret(token));
  if (!invitation) {
    throw new DomainError("invitation_not_found", "Convite não encontrado", 404);
  }
  return invitation;
}

export async function previewInvitationByToken(
  deps: KernelDeps,
  token: string,
): Promise<InvitationPublicView> {
  const invitation = await loadByToken(deps, token);
  const now = kernelNow(deps);
  assertUsableInvitation(invitation, now);
  return toPublicInvitation(invitation, now);
}

export async function requestContactVerification(
  deps: KernelDeps,
  input: { token: string; requestId?: string | null },
): Promise<{ invitation: InvitationPublicView; verificationToken: string }> {
  const invitation = await loadByToken(deps, input.token);
  const now = kernelNow(deps);
  assertUsableInvitation(invitation, now);

  if (invitation.contactVerifiedAt) {
    return {
      invitation: toPublicInvitation(invitation, now),
      verificationToken: "",
    };
  }
  if (invitation.verificationRequests >= MAX_VERIFICATION_REQUESTS) {
    throw new DomainError(
      "verification_rate_limited",
      "Demasiados pedidos de verificação de contacto",
      429,
    );
  }

  const code = generateVerificationCode();
  const verificationToken = generateOpaqueToken();
  const repo = createInvitationRepo(deps.db);
  const updated = await repo.markVerificationIssued({
    id: invitation.id,
    verificationCodeHash: hashOpaqueSecret(code),
    verificationTokenHash: hashOpaqueSecret(verificationToken),
    verificationExpiresAt: new Date(now.getTime() + VERIFICATION_CODE_TTL_MS),
    verificationRequests: invitation.verificationRequests + 1,
  });

  const minuteBucket = Math.floor(now.getTime() / 60_000);
  await enqueueOutboxJob(deps, {
    tenantId: invitation.tenantId,
    jobType: OUTBOX_JOB_TYPES.notifyInvitationVerify,
    idempotencyKey: `notify:invitation-verify:${invitation.id}:${minuteBucket}`,
    payload: {
      invitationId: invitation.id,
      canal: invitation.canal,
      destination: invitation.contacto,
      code,
      verificationToken,
    },
    correlationId: input.requestId ?? null,
  });
  await processOutbox(deps);

  return {
    invitation: toPublicInvitation(updated ?? invitation, now),
    verificationToken,
  };
}

export async function confirmContactVerification(
  deps: KernelDeps,
  input: {
    token: string;
    code?: string | null;
    verificationToken?: string | null;
    requestId?: string | null;
  },
): Promise<InvitationPublicView> {
  const invitation = await loadByToken(deps, input.token);
  const now = kernelNow(deps);
  assertUsableInvitation(invitation, now);

  if (invitation.contactVerifiedAt) {
    return toPublicInvitation(invitation, now);
  }
  if (invitation.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    throw new DomainError(
      "verification_locked",
      "Verificação de contacto bloqueada após demasiadas tentativas",
      429,
    );
  }
  if (
    !invitation.verificationExpiresAt ||
    invitation.verificationExpiresAt.getTime() <= now.getTime()
  ) {
    throw new DomainError("verification_expired", "Código/link de verificação expirado", 410);
  }

  const codeOk =
    Boolean(input.code?.trim()) &&
    invitation.verificationCodeHash === hashOpaqueSecret(input.code!.trim());
  const linkOk =
    Boolean(input.verificationToken?.trim()) &&
    invitation.verificationTokenHash === hashOpaqueSecret(input.verificationToken!.trim());

  if (!codeOk && !linkOk) {
    await createInvitationRepo(deps.db).incrementVerificationAttempts(
      invitation.id,
      invitation.verificationAttempts + 1,
    );
    throw new DomainError("verification_invalid", "Código ou link de verificação inválido", 400);
  }

  const verified = await createInvitationRepo(deps.db).markContactVerified(invitation.id, now);
  await createAuditEventRepo(deps.db).append({
    tenantId: invitation.tenantId,
    type: AUDIT_TYPES.invitationContactVerified,
    entityType: "invitation",
    entityId: invitation.id,
    after: { contactVerified: true, method: codeOk ? "code" : "link" },
    reason: "contact_verification",
    source: "invitation",
    requestId: input.requestId ?? null,
  });

  return toPublicInvitation(verified ?? invitation, now);
}
