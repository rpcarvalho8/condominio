/**
 * Seed GDPR config — lê ficheiros locais gitignored e grava em `configuracoes`.
 * Não contém PII no código-fonte.
 *
 * Pré-requisitos (repo root, ignorados pelo Git):
 *   - identify-data.json  (pagamentosNaoCategorizados, portaoDevedores, …)
 *   - cartas-julho-data.json (cartas[])
 *
 * Uso: bun --env-file=../../.env run src/api/database/seed-gdpr-config.ts
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "./index";
import { configuracoes } from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

async function upsert(chave: string, valor: unknown) {
  const json = typeof valor === "string" ? valor : JSON.stringify(valor);
  await db
    .insert(configuracoes)
    .values({ chave, valor: json, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: configuracoes.chave,
      set: { valor: json, updatedAt: new Date() },
    });
  console.log(`✅ ${chave} (${json.length} chars)`);
}

async function main() {
  const identifyPath = resolve(REPO_ROOT, "identify-data.json");
  const cartasPath = resolve(REPO_ROOT, "cartas-julho-data.json");

  if (!existsSync(identifyPath)) {
    throw new Error(`Falta ${identifyPath} (gitignored). Restaura o backup local.`);
  }

  const idf = JSON.parse(readFileSync(identifyPath, "utf8"));

  if (idf.pagamentosNaoCategorizados) {
    await upsert("pagamentos_nao_categorizados", idf.pagamentosNaoCategorizados);
  } else {
    console.warn("⚠️  identify-data.json sem pagamentosNaoCategorizados — skip");
  }

  for (const [field, chave] of [
    ["portaoDevedores", "portao_devedores"],
    ["indaquaDevedores", "indaqua_devedores"],
    ["fundoReservaDevedores", "fundo_reserva_devedores"],
    ["incendioDevedores", "incendio_devedores"],
    ["quotaExtraDevedores", "quota_extra_devedores"],
  ] as const) {
    if (idf[field]) await upsert(chave, idf[field]);
    else console.warn(`⚠️  identify-data.json sem ${field} — skip`);
  }

  if (existsSync(cartasPath)) {
    const cartas = JSON.parse(readFileSync(cartasPath, "utf8"));
    await upsert("cartas_julho_2026", cartas.cartas ?? cartas);
  } else {
    console.warn(`⚠️  Falta ${cartasPath} — cartas não seedadas`);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
