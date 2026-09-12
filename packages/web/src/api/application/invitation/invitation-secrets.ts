import { eq } from "drizzle-orm";
import { outboxJobs } from "../../database/schema";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import type { KernelDeps } from "../../infra/kernel-deps";

const SENSITIVE_OUTBOX_KEYS = new Set(["token", "code", "verificationToken"]);

export type IssuedContactVerification = {
  code: string;
  verificationToken: string;
};

const issuedByInvitation = new Map<string, IssuedContactVerification>();

export function rememberIssuedContactVerification(
  invitationId: string,
  secrets: IssuedContactVerification,
): void {
  issuedByInvitation.set(invitationId, secrets);
}

export function resetInvitationSecretHarness(): void {
  issuedByInvitation.clear();
}

export function redactInvitationOutboxPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = SENSITIVE_OUTBOX_KEYS.has(key) ? "[REDACTED]" : value;
  }
  return out;
}

export function isInvitationNotifyJob(jobType: string): boolean {
  return (
    jobType === OUTBOX_JOB_TYPES.notifyInvitationCreated ||
    jobType === OUTBOX_JOB_TYPES.notifyInvitationVerify
  );
}

function secretsFromPayload(payload: Record<string, unknown>): IssuedContactVerification | null {
  const code = payload.code;
  const verificationToken = payload.verificationToken;
  if (
    typeof code === "string" &&
    code &&
    code !== "[REDACTED]" &&
    typeof verificationToken === "string" &&
    verificationToken &&
    verificationToken !== "[REDACTED]"
  ) {
    return { code, verificationToken };
  }
  return null;
}

/**
 * Test/ops harness: read code + verificationToken from pending outbox payload
 * when still plaintext; fall back to in-memory capture after redact-on-complete.
 * Never exposed on HTTP responses.
 */
export async function readContactVerificationFromOutbox(
  deps: KernelDeps,
  invitationId: string,
): Promise<IssuedContactVerification> {
  const jobs = await deps.db
    .select()
    .from(outboxJobs)
    .where(eq(outboxJobs.jobType, OUTBOX_JOB_TYPES.notifyInvitationVerify));
  const newest = [...jobs]
    .filter((row) => {
      try {
        const payload = JSON.parse(row.payloadJson) as { invitationId?: string };
        return payload.invitationId === invitationId;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (newest) {
    try {
      const fromOutbox = secretsFromPayload(JSON.parse(newest.payloadJson) as Record<string, unknown>);
      if (fromOutbox) return fromOutbox;
    } catch {
      /* fall through to harness */
    }
  }
  const harness = issuedByInvitation.get(invitationId);
  if (harness) return harness;
  throw new Error(`verification secrets not found for invitation ${invitationId}`);
}
