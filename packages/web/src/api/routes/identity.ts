/**
 * Identity Routes — API para a Matriz de Identidade
 *
 * GET  /api/identity/fracoes           — lista completa da matriz
 * GET  /api/identity/fracoes/:id       — detalhe de uma fração
 * GET  /api/identity/fracoes/iban/:iban— frações associadas a um IBAN
 * POST /api/identity/identify          — identifica fração por múltiplos critérios
 * POST /api/identity/learn-iban        — regista manualmente novo IBAN
 * GET  /api/identity/dividas           — sumário de dívidas por tipo
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import {
  MATRIZ_PROPRIEDADES,
  getFracaoById,
  getFracaoByIBAN,
  identifyByMultiMatch,
  learnIBAN,
  getFracoesComDividas,
  totalDividasPorTipo,
} from "../lib/identity-matrix";

export const identityRoutes = new Hono()

  // ── GET /api/identity/fracoes ──────────────────────────────────────────────
  .get("/fracoes", requireAdmin, (c) => {
    return c.json({
      total: MATRIZ_PROPRIEDADES.length,
      fracoes: MATRIZ_PROPRIEDADES,
    });
  })

  // ── GET /api/identity/fracoes/:id ──────────────────────────────────────────
  .get("/fracoes/:id", requireAdmin, (c) => {
    const id = c.req.param("id");
    const fracao = getFracaoById(id);
    if (!fracao) return c.json({ error: `Fração '${id}' não encontrada` }, 404);
    return c.json(fracao);
  })

  // ── GET /api/identity/fracoes/iban/:iban ───────────────────────────────────
  .get("/fracoes/iban/:iban", requireAdmin, async (c) => {
    const iban = c.req.param("iban");
    const fracoes = await getFracaoByIBAN(iban);
    return c.json({
      iban,
      found: fracoes.length,
      fracoes,
    });
  })

  // ── POST /api/identity/identify ────────────────────────────────────────────
  // Body: { descricao, amount, ibanSender?, debtorName? }
  .post("/identify", requireAdmin, async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON inválido" }, 400);
    }

    const { descricao, amount, ibanSender, debtorName } = body;

    if (!descricao || typeof amount !== "number") {
      return c.json({ error: "Campos obrigatórios: descricao (string), amount (number)" }, 400);
    }

    const result = await identifyByMultiMatch({ descricao, amount, ibanSender, debtorName });

    if (!result) {
      return c.json({
        identificado: false,
        mensagem: "Não foi possível identificar a fração com confiança suficiente (score < 55 ou < 2 critérios)",
      });
    }

    return c.json({
      identificado: true,
      fracao: result.fracao,
      confidence: result.confidence,
      criterios: result.criterios,
      ibanNovoAprendido: result.ibanNovoAprendido,
    });
  })

  // ── POST /api/identity/learn-iban ──────────────────────────────────────────
  // Body: { idFracao, iban }
  .post("/learn-iban", requireAdmin, async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON inválido" }, 400);
    }

    const { idFracao, iban } = body;
    if (!idFracao || !iban) {
      return c.json({ error: "Campos obrigatórios: idFracao, iban" }, 400);
    }

    const fracao = getFracaoById(idFracao);
    if (!fracao) return c.json({ error: `Fração '${idFracao}' não encontrada` }, 404);

    const aprendido = await learnIBAN(idFracao, iban);

    return c.json({
      ok: true,
      ibanNovoAprendido: aprendido,
      mensagem: aprendido
        ? `IBAN ${iban} registado como novo para fração ${idFracao}`
        : `IBAN ${iban} já estava associado à fração ${idFracao}`,
      ibansConhecidos: fracao.ibansConhecidos,
    });
  })

  // ── GET /api/identity/dividas ──────────────────────────────────────────────
  .get("/dividas", requireAdmin, (c) => {
    const totais = totalDividasPorTipo();
    const comDividas = getFracoesComDividas();

    return c.json({
      totais,
      totalGeral: totais.obras + totais.incendio + totais.indaqua + totais.motor,
      fracoesComDividas: comDividas.length,
      detalhe: comDividas.map((f) => ({
        idFracao: f.idFracao,
        nomeProprietario: f.nomeProprietario,
        descricao: f.descricao,
        dividasAtuais: f.dividasAtuais,
        totalDivida: Object.values(f.dividasAtuais).reduce((s, v) => s + v, 0),
      })),
    });
  });
