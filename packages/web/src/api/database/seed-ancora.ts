// seed-ancora.ts
import { db } from "./index";
import { configuracoes } from "./schema";

const VALORES_ANCORA = [
  // ── Saldos de Abertura T₀ = 15/06/2026 ──
  { chave: "ancora_data_cc",          valor: "2026-06-15" },
  { chave: "ancora_data_movimentos",  valor: "2026-06-02" },
  { chave: "ancora_saldo_cc",         valor: "1806.74" },
  { chave: "ancora_saldo_fr",         valor: "651.30" },
  { chave: "ancora_saldo_elevadores", valor: "110.45" },
  { chave: "ancora_saldo_obras",      valor: "21185.29" },
  // ── Saldos calculados iniciais ──
  { chave: "atraso_fundo_reserva",    valor: "7.21" },
  { chave: "a_receber_incendio",      valor: "157.98" },
  { chave: "a_receber_obras",         valor: "6006.05" },
  { chave: "a_receber_quota_extra",   valor: "1723.56" },
  { chave: "a_receber_portao",        valor: "593.27" },
  { chave: "divida_total_motor",      valor: "98.48" },
  { chave: "divida_total_incendio",   valor: "110.12" },
  { chave: "divida_total_elevadores", valor: "308.21" },
  { chave: "divida_total_obras",      valor: "4357.75" },
];

async function seedAncora() {
  for (const entry of VALORES_ANCORA) {
    await db
      .insert(configuracoes)
      .values({ ...entry, updatedAt: new Date() })
      .onConflictDoNothing(); // não sobrescreve se já existir
  }
  console.log(`✅ ${VALORES_ANCORA.length} valores de âncora inseridos`);
}

seedAncora().catch(console.error);