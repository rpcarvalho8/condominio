/**
 * Bank Movements Route — /api/bank-movements
 * Fonte única: tabela bank_transactions (Enable Banking via Turso).
 * CSV histórico removido da interface principal.
 *
 * PATCH /:id/classificacao — após gravar importType, repõe imported=0 e dispara
 * processarStagedTransactions() que corre:
 *   1. Motor matricial (identifyByMultiMatch)
 *   2. Cascata de amortização (processarCascataAmortizacao)
 *   3. recalcularSaldos() → atualiza dashboard + dívidas por fração
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import { bankTransactions } from "../database/schema";
import { eq, desc } from "drizzle-orm";
import { processarStagedTransactions } from "./bank";
import { recalcularSaldos } from "./dashboard";

// Classificações mapeadas ao domínio real do condomínio
// importType no DB: "quota" | "quota_obras" | "quota_incendio" | "quota_motor" | "despesa"
const VALID_CLASSIFICATIONS = [
  "quota",
  "quota_obras",
  "quota_incendio",
  "quota_motor",
  "despesa",
] as const;
type Classification = typeof VALID_CLASSIFICATIONS[number];

// Mapear campos DB → shape uniforme para o frontend
function mapRow(r: typeof bankTransactions.$inferSelect) {
  const amount = r.amount ?? 0;
  const tipo: "Entrada" | "Saída" = amount >= 0 ? "Entrada" : "Saída";
  const dateStr = r.date
    ? (r.date instanceof Date ? r.date : new Date(r.date as unknown as number)).toISOString().slice(0, 10)
    : "—";
  return {
    id:                r.id,
    dataOperacao:      dateStr,
    descritivo:        r.description ?? "—",
    montante:          parseFloat(amount.toFixed(2)),
    tipo,
    categoria:         r.importType ?? "Não classificado",
    categoriaSource:   r.importType ? "auto" : "unmatched",
    nomeIdentificado:  r.debtorName ?? r.creditorName ?? undefined,
    notaCategorizacao: r.debtorName ?? r.creditorName ?? undefined,
    status:            r.status ?? "pending",
    requiresReview:    !!r.requiresManualReview,
  };
}

export const bankMovementsRoutes = new Hono()

  // GET /api/bank-movements — stats gerais da DB
  .get("/", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions).orderBy(desc(bankTransactions.date));

      const entradas = rows.filter(r => (r.amount ?? 0) >= 0);
      const saidas   = rows.filter(r => (r.amount ?? 0) < 0);
      const totalEntradas = parseFloat(entradas.reduce((s, r) => s + Math.abs(r.amount ?? 0), 0).toFixed(2));
      const totalSaidas   = parseFloat(saidas.reduce((s, r)   => s + Math.abs(r.amount ?? 0), 0).toFixed(2));
      const saldoFinal    = parseFloat((totalEntradas - totalSaidas).toFixed(2));

      // Categorias únicas
      const catMap: Record<string, { count: number; total: number }> = {};
      for (const r of rows) {
        const cat = r.importType ?? "Não classificado";
        if (!catMap[cat]) catMap[cat] = { count: 0, total: 0 };
        catMap[cat].count++;
        catMap[cat].total += Math.abs(r.amount ?? 0);
      }

      const naoClas = rows.filter(r => !r.importType).length;

      return c.json({
        ok: true,
        fonte: "db",
        csvDisponivel: false,
        condominio: rows.length > 0 ? {
          totalMovimentos: rows.length,
          estatisticas: {
            entradas:     entradas.length,
            saidas:       saidas.length,
            totalEntradas,
            totalSaidas,
            saldoFinal,
            categorizados:      rows.length - naoClas,
            naoCategorizado:    naoClas,
            despesasBancarias:  0,
            porFracao:    {},
            porCategoria: catMap,
            pagamentosNaoIdentificados: [],
          },
        } : null,
        obras: null,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/condominio — lista paginada com filtros
  .get("/condominio", requireAdmin, async (c) => {
    try {
      const categoria = c.req.query("categoria");
      const tipo      = c.req.query("tipo");   // "Entrada" | "Saída"
      const page      = parseInt(c.req.query("page") ?? "1");
      const pageSize  = parseInt(c.req.query("pageSize") ?? "50");

      const rows = await db.select().from(bankTransactions).orderBy(desc(bankTransactions.date));

      let mapped = rows.map(mapRow);

      if (categoria) mapped = mapped.filter(m => m.categoria === categoria);
      if (tipo)      mapped = mapped.filter(m => m.tipo === tipo);

      const total = mapped.length;
      const start = (page - 1) * pageSize;
      const paged = mapped.slice(start, start + pageSize);

      return c.json({
        ok: true,
        fonte: "db",
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize),
        movimentos: paged,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // PATCH /api/bank-movements/:id/classificacao — gravar classificação manual
  // GATILHO EM CASCATA:
  //   1. Grava importType + repõe imported=0 (força reprocessamento)
  //   2. processarStagedTransactions() → motor matricial + cascata amortização
  //   3. recalcularSaldos() já é invocado dentro de processarStagedTransactions()
  //      → dashboard + dívidas por fração ficam sincronizados imediatamente
  .patch("/:id/classificacao", requireAdmin, async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json<{ classificacao: string }>();
      const classificacao = body.classificacao as Classification;

      if (!VALID_CLASSIFICATIONS.includes(classificacao)) {
        return c.json({
          ok: false,
          error: `Classificação inválida. Valores permitidos: ${VALID_CLASSIFICATIONS.join(", ")}`,
        }, 400);
      }

      // ── Passo 1: Gravar nova classificação + repor imported=0 ──────────────
      // Repor imported=0 força processarStagedTransactions() a reprocessar esta TXN.
      // requiresManualReview=0 para que não seja ignorada pelo motor.
      await db
        .update(bankTransactions)
        .set({
          importType: classificacao,
          imported: 0,
          requiresManualReview: 0,
          status: "pending",
        })
        .where(eq(bankTransactions.id, id));

      // ── Passo 2: Motor em cascata ──────────────────────────────────────────
      // processarStagedTransactions() processa TODAS as TXNs com imported=0.
      // Inclui a que acabámos de repor. O motor vai:
      //   a) Confirmar a fração via identifyByMultiMatch
      //   b) Criar/atualizar a quota correspondente (tipo = classificacao)
      //   c) Aplicar processarCascataAmortizacao → abater dívidas em atraso
      //   d) Chamar recalcularSaldos() → dashboard + morosidade atualizados
      const engineResult = await processarStagedTransactions();

      // Fallback: se a TXN ficou em manual_review (motor não identificou fração),
      // pelo menos recalcular saldos para reflectir a mudança de categoria.
      const manualReviewCount = engineResult.manualReview;
      if (manualReviewCount > 0) {
        await recalcularSaldos();
      }

      return c.json({
        ok: true,
        id,
        importType: classificacao,
        engine: {
          processed:    engineResult.processed,
          manualReview: engineResult.manualReview,
          errors:       engineResult.errors,
        },
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/categorias — distribuição por categoria
  .get("/categorias", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions);

      const catMap: Record<string, { count: number; total: number }> = {};
      for (const r of rows) {
        const cat = r.importType ?? "Não classificado";
        if (!catMap[cat]) catMap[cat] = { count: 0, total: 0 };
        catMap[cat].count++;
        catMap[cat].total += Math.abs(r.amount ?? 0);
      }

      const categorias = Object.entries(catMap)
        .map(([cat, s]) => ({ categoria: cat, count: s.count, total: parseFloat(s.total.toFixed(2)) }))
        .sort((a, b) => b.total - a.total);

      return c.json({ ok: true, categorias });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/resumo-fracoes — stub (sem CSV, sem dados por fração)
  .get("/resumo-fracoes", requireAdmin, async (c) => {
    return c.json({ ok: true, resumo: [] });
  })

  // GET /api/bank-movements/reconciliacao — reconciliação básica da DB
  .get("/reconciliacao", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions);

      const bySource = { csv: 0, auto: rows.filter(r => !!r.importType).length, unmatched: rows.filter(r => !r.importType).length };
      const pct = rows.length > 0
        ? parseFloat(((bySource.auto / rows.length) * 100).toFixed(1))
        : 0;

      return c.json({
        ok: true,
        resumo: {
          totalMovimentos: rows.length,
          porSource: bySource,
          percentagemCategorizado: pct,
          totalEntradas: rows.filter(r => (r.amount ?? 0) >= 0).reduce((s, r) => s + (r.amount ?? 0), 0),
          categorizadosAuto: bySource.auto,
        },
        portaoStatus: [],
        autoCatEntradas: rows
          .filter(r => !!r.importType && (r.amount ?? 0) >= 0)
          .map(r => ({
            data:         r.date ? (r.date instanceof Date ? r.date : new Date(r.date as unknown as number)).toISOString().slice(0, 10) : "—",
            descritivo:   r.description ?? "—",
            montante:     r.amount ?? 0,
            categoria:    r.importType ?? "—",
            subCategoria: "",
            nota:         r.debtorName ?? r.creditorName ?? "—",
          }))
          .slice(0, 200),
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
