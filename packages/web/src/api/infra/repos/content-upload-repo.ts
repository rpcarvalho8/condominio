import { and, eq } from "drizzle-orm";
import { contentUploads } from "../../database/schema";
import type { ContentUpload, RegisterUploadInput } from "../../domain/upload";
import type { KernelDb } from "../kernel-deps";

function mapRow(row: typeof contentUploads.$inferSelect): ContentUpload {
  return {
    id: row.id,
    tenantId: row.tenantId,
    contentHash: row.contentHash,
    filename: row.filename,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
  };
}

export function createContentUploadRepo(db: KernelDb) {
  return {
    async findByHash(tenantId: string, contentHash: string): Promise<ContentUpload | null> {
      const [row] = await db
        .select()
        .from(contentUploads)
        .where(
          and(eq(contentUploads.tenantId, tenantId), eq(contentUploads.contentHash, contentHash)),
        )
        .limit(1);
      return row ? mapRow(row) : null;
    },
    async insert(input: RegisterUploadInput & { id: string; createdAt: Date }): Promise<ContentUpload> {
      const [row] = await db
        .insert(contentUploads)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          contentHash: input.contentHash,
          filename: input.filename,
          byteSize: input.byteSize,
          createdAt: input.createdAt,
        })
        .returning();
      return mapRow(row!);
    },
  };
}

export type ContentUploadRepo = ReturnType<typeof createContentUploadRepo>;
