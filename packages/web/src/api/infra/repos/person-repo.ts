import { eq } from "drizzle-orm";
import { persons } from "../../database/schema";
import type { Person } from "../../domain/person";
import { normalizeEmail } from "../../domain/person";
import type { KernelDb } from "../kernel-deps";

function mapPerson(row: typeof persons.$inferSelect): Person {
  return {
    id: row.id,
    userId: row.userId ?? null,
    name: row.name,
    nif: row.nif ?? null,
    email: row.email,
    phone: row.phone ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPersonRepo(db: KernelDb) {
  return {
    async findById(id: string): Promise<Person | null> {
      const [row] = await db.select().from(persons).where(eq(persons.id, id)).limit(1);
      return row ? mapPerson(row) : null;
    },
    async findByUserId(userId: string): Promise<Person | null> {
      const [row] = await db.select().from(persons).where(eq(persons.userId, userId)).limit(1);
      return row ? mapPerson(row) : null;
    },
    async findByEmail(email: string): Promise<Person | null> {
      const [row] = await db
        .select()
        .from(persons)
        .where(eq(persons.email, normalizeEmail(email)))
        .limit(1);
      return row ? mapPerson(row) : null;
    },
    async insert(input: {
      id: string;
      userId?: string | null;
      name: string;
      nif?: string | null;
      email: string;
      phone?: string | null;
      createdAt: Date;
    }): Promise<Person> {
      const [row] = await db
        .insert(persons)
        .values({
          id: input.id,
          userId: input.userId ?? null,
          name: input.name.trim(),
          nif: input.nif?.trim() ? input.nif.trim() : null,
          email: normalizeEmail(input.email),
          phone: input.phone?.trim() ? input.phone.trim() : null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning();
      return mapPerson(row!);
    },
  };
}

export type PersonRepo = ReturnType<typeof createPersonRepo>;
