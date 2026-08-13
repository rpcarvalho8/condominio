import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and } from "drizzle-orm";

export const quotas = new Hono()
  .get("/", async (c) => {
    const mes = c.req.query("mes");
    const ano = c.req.query("ano");
    const fracaoId = c.req.query("fracaoId");
    const tipo = c.req.query("tipo");

    let query = db
      .select({
        quota: schema.quotas,
        fracao: schema.fracoes,
      })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id));

    const conditions = [];
    if (mes) conditions.push(eq(schema.quotas.mes, parseInt(mes)));
    if (ano) conditions.push(eq(schema.quotas.ano, parseInt(ano)));
    if (fracaoId) conditions.push(eq(schema.quotas.fracaoId, fracaoId));
    if (tipo) conditions.push(eq(schema.quotas.tipo, tipo));

    const all = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query;

    return c.json({ quotas: all }, 200);
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    const [quota] = await db.insert(schema.quotas).values(body).returning();
    return c.json({ quota }, 201);
  })
  .post("/gerar-mensal", async (c) => {
    // Gera quotas para todas as frações ativas para um dado mês/ano
    const { mes, ano } = await c.req.json();
    const fracoesList = await db.select().from(schema.fracoes).where(eq(schema.fracoes.ativo, true));

    const novasQuotas = [];
    for (const fracao of fracoesList) {
      // Verificar se já existe
      const [existente] = await db.select().from(schema.quotas).where(
        and(eq(schema.quotas.fracaoId, fracao.id), eq(schema.quotas.mes, mes), eq(schema.quotas.ano, ano))
      );
      if (!existente) {
        const [quota] = await db.insert(schema.quotas).values({
          fracaoId: fracao.id,
          mes,
          ano,
          valor: fracao.quotaMensal,
        }).returning();
        novasQuotas.push(quota);
      }
    }
    return c.json({ criadas: novasQuotas.length, quotas: novasQuotas }, 201);
  })
  /** Gera cota extra só para as frações indicadas (ex.: campainhas). */
  .post("/gerar-extra", async (c) => {
    const body = await c.req.json();
    const {
      fracaoIds,
      fracaoNumeros,
      valor,
      nome,
      keywords,
      descricao,
      mes,
      ano,
      quotaTipoId,
    } = body as {
      fracaoIds?: string[];
      fracaoNumeros?: string[];
      valor: number;
      nome?: string;
      keywords?: string;
      descricao?: string;
      mes?: number;
      ano?: number;
      quotaTipoId?: string;
    };

    if (!valor || valor <= 0) {
      return c.json({ error: "Valor obrigatório e > 0" }, 400);
    }

    const now = new Date();
    const mesQ = mes ?? (now.getMonth() + 1);
    const anoQ = ano ?? now.getFullYear();

    let tipoId = quotaTipoId ?? null;
    if (!tipoId && nome) {
      const [tipo] = await db.insert(schema.quotaTipos).values({
        nome,
        tipo: "extra",
        descricao: descricao ?? null,
        keywords: keywords ?? null,
        valorBase: valor,
        ativo: true,
      }).returning();
      tipoId = tipo.id;
    }

    const allFracoes = await db.select().from(schema.fracoes).where(eq(schema.fracoes.ativo, true));
    const byId = new Map(allFracoes.map((f) => [f.id, f]));
    const byNum = new Map(allFracoes.map((f) => [f.numero.toUpperCase(), f]));

    const targets: typeof allFracoes = [];
    for (const id of fracaoIds ?? []) {
      const f = byId.get(id);
      if (f) targets.push(f);
    }
    for (const num of fracaoNumeros ?? []) {
      const f = byNum.get(String(num).toUpperCase());
      if (f && !targets.some((t) => t.id === f.id)) targets.push(f);
    }

    if (targets.length === 0) {
      return c.json({ error: "Seleccione pelo menos uma fração" }, 400);
    }

    const criadas = [];
    const saltadas = [];
    for (const fracao of targets) {
      const existing = await db.select({ id: schema.quotas.id }).from(schema.quotas).where(
        and(
          eq(schema.quotas.fracaoId, fracao.id),
          eq(schema.quotas.mes, mesQ),
          eq(schema.quotas.ano, anoQ),
          eq(schema.quotas.tipo, "extra"),
          tipoId ? eq(schema.quotas.quotaTipoId, tipoId) : eq(schema.quotas.valor, valor),
        ),
      ).limit(1);
      if (existing.length > 0) {
        saltadas.push(fracao.numero);
        continue;
      }
      const [q] = await db.insert(schema.quotas).values({
        fracaoId: fracao.id,
        quotaTipoId: tipoId,
        tipo: "extra",
        mes: mesQ,
        ano: anoQ,
        valor,
        fundoReserva: 0,
        pago: false,
        observacoes: nome ? `[extra:${nome}]` : null,
      }).returning();
      criadas.push({ id: q.id, fracao: fracao.numero });
    }

    return c.json({
      criadas: criadas.length,
      saltadas,
      quotaTipoId: tipoId,
      quotas: criadas,
    }, 201);
  })
  .patch("/:id/pagar", async (c) => {
    const id = c.req.param("id");
    const { metodoPagamento, observacoes } = await c.req.json();
    const [quota] = await db.update(schema.quotas).set({
      pago: true,
      dataPagamento: new Date(),
      metodoPagamento: metodoPagamento || "transferência",
      observacoes,
    }).where(eq(schema.quotas.id, id)).returning();
    return c.json({ quota }, 200);
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const updateData: any = {};
    if ("quotaTipoId" in body) updateData.quotaTipoId = body.quotaTipoId;
    if ("observacoes" in body) updateData.observacoes = body.observacoes;
    const [quota] = await db.update(schema.quotas).set(updateData).where(eq(schema.quotas.id, id)).returning();
    return c.json({ quota }, 200);
  })
  .patch("/:id/desmarcar", async (c) => {
    const id = c.req.param("id");
    const [quota] = await db.update(schema.quotas).set({
      pago: false,
      dataPagamento: null,
      metodoPagamento: null,
    }).where(eq(schema.quotas.id, id)).returning();
    return c.json({ quota }, 200);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    await db.delete(schema.quotas).where(eq(schema.quotas.id, id));
    return c.json({ success: true }, 200);
  });
