/**
 * Corrige proprietários na BD e em identify-data.json (se existir).
 * Uso: bun --env-file=../../.env run scripts/fix-proprietarios-fracoes.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../src/api/database";
import { fracoes } from "../src/api/database/schema";
import { loadMatrizFromDB } from "../src/api/lib/identity-matrix";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const IDENTIFY_PATH = path.join(REPO_ROOT, "identify-data.json");

/** Correções confirmadas pela administração */
const CORRECOES: Array<{ numero: string; proprietarioNome: string }> = [
  { numero: "AI", proprietarioNome: "Rui Carvalho" },
  { numero: "G", proprietarioNome: "Marco Maia" },
];

async function patchDb() {
  for (const { numero, proprietarioNome } of CORRECOES) {
    const [row] = await db
      .select({ id: fracoes.id, proprietarioNome: fracoes.proprietarioNome })
      .from(fracoes)
      .where(eq(fracoes.numero, numero))
      .limit(1);

    if (!row) {
      console.warn(`⚠️  Fração ${numero} não encontrada na BD — skip`);
      continue;
    }

    await db
      .update(fracoes)
      .set({ proprietarioNome })
      .where(eq(fracoes.id, row.id));

    console.log(`✓ BD ${numero}: "${row.proprietarioNome ?? "—"}" → "${proprietarioNome}"`);
  }
}

function patchIdentifyDataJson() {
  if (!existsSync(IDENTIFY_PATH)) {
    console.warn("⚠️  identify-data.json não encontrado — só BD actualizada");
    return;
  }

  const raw = readFileSync(IDENTIFY_PATH, "utf-8");
  const data = JSON.parse(raw) as { fracoes?: Array<{ idFracao: string; nomeProprietario: string }> };
  if (!Array.isArray(data.fracoes)) {
    console.warn("⚠️  identify-data.json sem array fracoes — skip ficheiro");
    return;
  }

  for (const fix of CORRECOES) {
    const entry = data.fracoes.find((f) => f.idFracao.toUpperCase() === fix.numero);
    if (!entry) {
      console.warn(`⚠️  identify-data: fração ${fix.numero} não encontrada`);
      continue;
    }
    const antes = entry.nomeProprietario;
    entry.nomeProprietario = fix.proprietarioNome;
    console.log(`✓ JSON ${fix.numero}: "${antes}" → "${fix.proprietarioNome}"`);
  }

  writeFileSync(IDENTIFY_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function main() {
  await patchDb();
  patchIdentifyDataJson();
  await loadMatrizFromDB();
  console.log("✅ Proprietários corrigidos; matriz recarregada.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
