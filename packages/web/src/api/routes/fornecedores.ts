import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";

export const fornecedores = new Hono()
  .get("/", async (c) => {
    const all = await db.select().from(schema.fornecedores).orderBy(schema.fornecedores.nome);
    return c.json({ fornecedores: all }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const body = await c.req.json();
    const [fornecedor] = await db.insert(schema.fornecedores).values(body).returning();
    return c.json({ fornecedor }, 201);
  })
  .patch("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const [fornecedor] = await db.update(schema.fornecedores).set(body).where(eq(schema.fornecedores.id, id)).returning();
    return c.json({ fornecedor }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    await db.update(schema.fornecedores).set({ ativo: false }).where(eq(schema.fornecedores.id, id));
    return c.json({ success: true }, 200);
  });
