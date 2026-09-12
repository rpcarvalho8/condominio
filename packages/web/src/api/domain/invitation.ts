import { createHash, randomBytes, randomInt } from "node:crypto";
import { DomainError } from "./errors";
import { isKernelRoleCode, type KernelRoleCode } from "./roles";

export const INVITATION_STATUS = {
  pending: "pending",
  accepted: "accepted",
  revoked: "revoked",
  expired: "expired",
} as const;

export type InvitationStatus = (typeof INVITATION_STATUS)[keyof typeof INVITATION_STATUS];

export const INVITATION_CHANNELS = {
  email: "email",
  sms: "sms",
} as const;

export type InvitationChannel = (typeof INVITATION_CHANNELS)[keyof typeof INVITATION_CHANNELS];

/** Default lifetime — few days (02-DOMINIO / 04-PORTAS). */
export const INVITATION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_VERIFICATION_ATTEMPTS = 5;
export const MAX_VERIFICATION_REQUESTS = 5;

/** 32 opaque bytes — never invitation id, tenant, or a sequential counter. */
export const OPAQUE_TOKEN_BYTES = 32;

export type Invitation = {
  id: string;
  tenantId: string;
  fracaoId: string;
  canal: InvitationChannel | string;
  contacto: string;
  personName: string | null;
  roleCode: KernelRoleCode | string;
  tokenHash: string;
  expiresAt: Date;
  status: InvitationStatus | string;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedByPersonId: string | null;
  loteId: string | null;
  contactVerifiedAt: Date | null;
  verificationCodeHash: string | null;
  verificationTokenHash: string | null;
  verificationExpiresAt: Date | null;
  verificationAttempts: number;
  verificationRequests: number;
  createdAt: Date;
  createdByPersonId: string | null;
  acceptedPersonId: string | null;
  acceptedMembershipId: string | null;
};

export type InvitationPublicView = {
  id: string;
  tenantId: string;
  fracaoId: string;
  canal: string;
  contactoMasked: string;
  /** Present only after contact verification — needed to create/associate the account. */
  contacto?: string;
  personName: string | null;
  roleCode: string;
  expiresAt: Date;
  status: InvitationStatus | string;
  loteId: string | null;
  contactVerified: boolean;
  usedAt: Date | null;
  createdAt: Date;
};

export function isInvitationChannel(value: string): value is InvitationChannel {
  return value === INVITATION_CHANNELS.email || value === INVITATION_CHANNELS.sms;
}

export function generateOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
}

export function hashOpaqueSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeContact(canal: string, contacto: string): string {
  const trimmed = contacto.trim();
  if (canal === INVITATION_CHANNELS.email) return trimmed.toLowerCase();
  return trimmed.replace(/\s+/g, "");
}

export function maskContact(canal: string, contacto: string): string {
  if (canal === INVITATION_CHANNELS.email) {
    const [local, domain] = contacto.split("@");
    if (!local || !domain) return "***";
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
  }
  if (contacto.length <= 4) return "***";
  return `${"*".repeat(Math.max(0, contacto.length - 4))}${contacto.slice(-4)}`;
}

export function deriveInvitationStatus(invitation: Invitation, now: Date): InvitationStatus {
  if (invitation.status === INVITATION_STATUS.revoked || invitation.revokedAt) {
    return INVITATION_STATUS.revoked;
  }
  if (invitation.status === INVITATION_STATUS.accepted || invitation.usedAt) {
    return INVITATION_STATUS.accepted;
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return INVITATION_STATUS.expired;
  }
  return INVITATION_STATUS.pending;
}

export function assertUsableInvitation(invitation: Invitation, now: Date): void {
  const status = deriveInvitationStatus(invitation, now);
  if (status === INVITATION_STATUS.revoked) {
    throw new DomainError("invitation_revoked", "Convite revogado", 410);
  }
  if (status === INVITATION_STATUS.accepted) {
    throw new DomainError("invitation_used", "Convite já foi utilizado", 409);
  }
  if (status === INVITATION_STATUS.expired) {
    throw new DomainError("invitation_expired", "Convite expirado", 410);
  }
}

export function toPublicInvitation(invitation: Invitation, now: Date): InvitationPublicView {
  return {
    id: invitation.id,
    tenantId: invitation.tenantId,
    fracaoId: invitation.fracaoId,
    canal: invitation.canal,
    contactoMasked: maskContact(invitation.canal, invitation.contacto),
    contacto: invitation.contactVerifiedAt ? invitation.contacto : undefined,
    personName: invitation.personName,
    roleCode: invitation.roleCode,
    expiresAt: invitation.expiresAt,
    status: deriveInvitationStatus(invitation, now),
    loteId: invitation.loteId,
    contactVerified: Boolean(invitation.contactVerifiedAt),
    usedAt: invitation.usedAt,
    createdAt: invitation.createdAt,
  };
}

export function defaultInvitationRole(roleCode?: string | null): KernelRoleCode {
  const code = roleCode?.trim() || "Owner";
  if (!isKernelRoleCode(code)) {
    throw new DomainError("invalid_role", `Role inválido: ${code}`, 400);
  }
  if (code === "Admin" || code === "PlatformAdmin") {
    throw new DomainError(
      "invalid_invitation_role",
      "Convite de condómino não atribui Admin/PlatformAdmin",
      400,
    );
  }
  return code;
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function assertInvitationTokenOpaque(token: string, invitationId: string): void {
  if (token.includes(invitationId)) {
    throw new DomainError("predictable_token", "Token não pode conter o id do convite", 500);
  }
}
