import { Hono } from "hono";
import { db } from "../database";
import { quotaTipos } from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";

export const quotaTiposRoutes = new Hono()
  // List all
  .get("/", async (c) => {
    const tipos = await db.select().from(quotaTipos).orderBy(quotaTipos.createdAt);
    return c.json(tipos);
  })
  // Create
  .post("/", requireAdmin, async (c) => {
    const body = await c.req.json();
    const [novo] = await db.insert(quotaTipos).values({
      nome: body.nome,
      tipo: body.tipo,
      descricao: body.descricao ?? null,
      keywords: body.keywords ?? null,
      valorBase: body.valorBase ?? null,
      ativo: body.ativo ?? true,
      dataInicio: body.dataInicio ? new Date(body.dataInicio) : null,
      dataFim: body.dataFim ? new Date(body.dataFim) : null,
    }).returning();
    return c.json(novo, 201);
  })
  // Update
  .put("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const [updated] = await db.update(quotaTipos)
      .set({
        nome: body.nome,
        tipo: body.tipo,
        descricao: body.descricao,
        keywords: body.keywords ?? null,
        valorBase: body.valorBase,
        ativo: body.ativo,
        dataInicio: body.dataInicio ? new Date(body.dataInicio) : null,
        dataFim: body.dataFim ? new Date(body.dataFim) : null,
      })
      .where(eq(quotaTipos.id, id))
      .returning();
    if (!updated) return c.json({ message: "Não encontrado" }, 404);
    return c.json(updated);
  })
  // Delete
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    await db.delete(quotaTipos).where(eq(quotaTipos.id, id));
    return c.json({ ok: true });
  });
