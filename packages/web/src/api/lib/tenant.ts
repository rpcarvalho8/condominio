import { CONDOMINIO } from "./condominio";

/**
 * Identidade do tenant da BD actual.
 *
 * Arquitectura LUMEN (ADR-016): 1 BD por condomínio.
 * Nesta app Fonte (um processo ↔ uma BD), o tenantId é o carimbo
 * de ownership dentro da BD — defesa em profundidade, não um modelo
 * multi-tenant partilhado. Em F0, cada BD de tenant continua isolada;
 * este campo impede acesso por ID cruzado se alguma BD for mal configurada
 * ou se testes injectarem dados de outro tenant.
 *
 * Fonte: TENANT_ID (env) → fallback NIF do condomínio configurado.
 * Nunca confiar num tenantId enviado pelo cliente.
 */
export function getCurrentTenantId(): string {
  const fromEnv = String(process.env.TENANT_ID ?? "").trim();
  if (fromEnv) return fromEnv;
  return CONDOMINIO.nif;
}
