/**
 * Bootstrap roles — ADR-006 / ADR-031.
 * Fiscalizacao is a control-capacity Role, not a ConselhoFiscal entity.
 */
export const KERNEL_ROLE_CODES = [
  "Owner",
  "CoOwner",
  "Proxy",
  "Admin",
  "PlatformAdmin",
  "Fiscalizacao",
] as const;

export type KernelRoleCode = (typeof KERNEL_ROLE_CODES)[number];

export const KERNEL_ROLE_CATALOG: ReadonlyArray<{
  code: KernelRoleCode;
  name: string;
  description: string;
}> = [
  { code: "Owner", name: "Owner", description: "Proprietário da fração" },
  { code: "CoOwner", name: "CoOwner", description: "Co-proprietário da fração" },
  { code: "Proxy", name: "Proxy", description: "Representante / procurador" },
  { code: "Admin", name: "Admin", description: "Administrador do condomínio" },
  { code: "PlatformAdmin", name: "PlatformAdmin", description: "Administrador da plataforma" },
  {
    code: "Fiscalizacao",
    name: "Fiscalizacao",
    description: "Capacidade de controlo: confirma ações sensíveis, não as cria",
  },
];

export function isKernelRoleCode(value: string): value is KernelRoleCode {
  return (KERNEL_ROLE_CODES as readonly string[]).includes(value);
}

export function canManageMemberships(roleCode: string): boolean {
  return roleCode === "Admin" || roleCode === "PlatformAdmin";
}
