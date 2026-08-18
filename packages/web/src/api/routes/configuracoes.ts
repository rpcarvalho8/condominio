import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";

// Saldos reais a 31.01.2026 (fonte: Contas_2026.xlsx)
// Santander Totta conta geral: €34,109.91
//   - Condomínio: €2,778.86
//   - Fundo de Reserva: €277.89
//   - Quota-Extra: €4,140.79 (conta Abanca separada, real: €4,401.93)
//   - Obras Fachada: €26,912.37 (conta Abanca separada, real: €26,495.53)
//   - Incêndio: €0 (obra paga ao empreiteiro — €157.98 ainda por receber de G/AC/AD)
// SINCRONIZADO com SALDO_DEFAULTS em dashboard.ts — manter em sync ao alterar.
const DEFAULTS: Record<string, string> = {
  saldo_conta_corrente:  "2778.86",
  saldo_fundo_reserva:   "277.89",
  atraso_fundo_reserva:  "7.21",    // corrigido: L pagou 25.47€ (23.99 pré-2026 + parcial Jan)
  saldo_obras:           "26912.37",
  saldo_quota_extra:     "4140.79",
  saldo_incendio:        "0",
  a_receber_incendio:    "157.98",
  a_receber_obras:       "6006.05",
  a_receber_quota_extra: "1723.56", // 1777.88 - 28.97(AH portão 07/05) - 25.35(AI portão 07/05)
  saldo_portao:          "0",
  a_receber_portao:      "593.27",  // 707.25 - 59.66(base) - 25.35(AI) - 28.97(AH)
  portao_pago:           "113.98",  // 59.66 + 25.35 + 28.97
  // Atas de assembleia — janela de votação e threshold mínimo
  atas_aprovacao_window_minutes: "30",
  // Threshold mínimo (% sobre permilagem total) para "aprovada"
  atas_aprovacao_threshold_percent: "50",
};

export const configuracoesRoutes = new Hono()
  // GET all configuracoes
  .get("/", async (c) => {
    const rows = await db.select().from(schema.configuracoes);
    const config: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      config[row.chave] = row.valor;
    }
    return c.json(config);
  })

  // PUT /api/configuracoes/:chave
  .put("/:chave", async (c) => {
    const chave = c.req.param("chave");
    const body = await c.req.json<{ valor: string }>();

    const existing = await db
      .select()
      .from(schema.configuracoes)
      .where(eq(schema.configuracoes.chave, chave))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.configuracoes)
        .set({ valor: body.valor, updatedAt: new Date() })
        .where(eq(schema.configuracoes.chave, chave));
    } else {
      await db.insert(schema.configuracoes).values({
        chave,
        valor: body.valor,
        updatedAt: new Date(),
      });
    }

    return c.json({ ok: true, chave, valor: body.valor });
  });
