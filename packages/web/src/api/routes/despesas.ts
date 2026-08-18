import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";

export const despesas = new Hono()
  .get("/", async (c) => {
    const all = await db
      .select({
        despesa: schema.despesas,
        fornecedor: schema.fornecedores,
      })
      .from(schema.despesas)
      .leftJoin(schema.fornecedores, eq(schema.despesas.fornecedorId, schema.fornecedores.id))
      .orderBy(desc(schema.despesas.data));
    return c.json({ despesas: all }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const body = await c.req.json();
    const [despesa] = await db.insert(schema.despesas).values({
      ...body,
      data: new Date(body.data),
    }).returning();
    return c.json({ despesa }, 201);
  })
  .patch("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const [despesa] = await db.update(schema.despesas).set(body).where(eq(schema.despesas.id, id)).returning();
    return c.json({ despesa }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    await db.delete(schema.despesas).where(eq(schema.despesas.id, id));
    return c.json({ success: true }, 200);
  });
