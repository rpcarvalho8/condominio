import { DomainError } from "../../domain/errors";
import {
  deriveInvitationStatus,
  toPublicInvitation,
  type InvitationPublicView,
} from "../../domain/invitation";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";

export async function listInvitations(
  deps: KernelDeps,
  input: { tenantId: string; loteId?: string | null },
): Promise<InvitationPublicView[]> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }
  const now = kernelNow(deps);
  const rows = await createInvitationRepo(deps.db).listByTenant(tenantId);
  return rows
    .filter((row) => (input.loteId ? row.loteId === input.loteId : true))
    .map((row) => {
      const view = toPublicInvitation(row, now);
      return { ...view, status: deriveInvitationStatus(row, now) };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
