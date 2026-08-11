/**
 * seed-dividas.ts — v2
 * Lê DIRETAMENTE o ficheiro Excel oficial (Valores Condomínio.xlsx)
 * e injeta os valores de dívida por fração na BD (tabela `fracoes`).
 *
 * Colunas lidas do Excel (aba "Valores"):
 *   Col B  (idx 1)  → numero da fração (FR)
 *   Col L  (idx 11) → obras_divida    ("Valores em dívida Quota Extra Obras")
 *   Col O  (idx 14) → incendio_divida ("Valores em dívida Quota Extra Incêndio")
 *   Col R  (idx 17) → indaqua_divida  ("Valores em dívida Quota extra Indaqua + elevadores")
 *   Col U  (idx 20) → motor_divida    ("Valores em dívida Quota extra motor")
 *
 * Caso de teste obrigatório (Fração L — Maria Santos):
 *   obras_divida  = 2110.97  (arredondado de 2110.96604166667)
 *   indaqua_divida = 250.56  (arredondado de 250.56119828816)
 *
 * Fontes de verdade (por ordem de prioridade):
 *   1. Ficheiro xlsx em $EXCEL_PATH (env var)
 *   2. Caminho hardcoded relativo ao workspace
 *
 * Usage:
 *   bun scripts/seed-dividas.ts             — aplica
 *   bun scripts/seed-dividas.ts --dry-run   — mostra sem alterar BD
 */

import * as path from "path";
import { db } from "../src/api/database";
import { sql } from "drizzle-orm";
import * as xlsx from "xlsx";

// ── Localizar o ficheiro Excel ───────────────────────────────────────────────
const EXCEL_CANDIDATES = [
  process.env.EXCEL_PATH,
  path.resolve(__dirname, "../../../../Valores_Condomínio.xlsx"),
  // Anexos do sandbox (sempre o mais recente com prefixo Valores_Condomínio)
  ...((() => {
    try {
      const fs = require("fs");
      const dir = "/home/user/Attachments";
      const files = fs.readdirSync(dir)
        .filter((f: string) => f.startsWith("Valores_Condom") && f.endsWith(".xlsx"))
        .map((f: string) => path.join(dir, f))
        .sort((a: string, b: string) => {
          // ordenar por mtime desc — mais recente primeiro
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        });
      return files;
    } catch {
      return [];
    }
  })()),
].filter(Boolean) as string[];

function findExcel(): string {
  const fs = require("fs");
  for (const p of EXCEL_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `Ficheiro Excel não encontrado. Defina EXCEL_PATH ou coloque-o em:\n${EXCEL_CANDIDATES.join("\n")}`
  );
}

// ── Tipos ────────────────────────────────────────────────────────────────────
type DividaRow = {
  numero: string;
  obras: number;
  incendio: number;
  indaqua: number;
  motor: number;
};

type BdRow = {
  obras_divida: number | null;
  incendio_divida: number | null;
  indaqua_divida: number | null;
  motor_divida: number | null;
};

// ── Leitura do Excel ─────────────────────────────────────────────────────────
// Usa endereçamento directo de células (B3, L3, etc.) para evitar problemas
// com merges e colunas vazias que confundem sheet_to_json.
function lerExcel(excelPath: string): DividaRow[] {
  const wb = xlsx.readFile(excelPath, { raw: true, cellNF: false });
  const ws = wb.Sheets["Valores"];
  if (!ws) throw new Error(`Aba "Valores" não encontrada em ${excelPath}`);

  const parseVal = (v: any): number => {
    if (v == null || v === "" || v === false) return 0;
    const n = parseFloat(String(v));
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  };

  const cell = (col: string, row: number): any => {
    const c = ws[`${col}${row}`];
    return c ? c.v : null;
  };

  // Range: B1:U43 — dados de frações a partir da linha 3
  const range = xlsx.utils.decode_range(ws["!ref"] || "B1:U43");
  const maxRow = range.e.r + 1; // 1-based

  const rows: DividaRow[] = [];

  for (let r = 3; r <= maxRow; r++) {
    const numero = cell("B", r);
    if (!numero || typeof numero !== "string" || numero.trim() === "") continue;

    rows.push({
      numero:   numero.trim(),
      obras:    parseVal(cell("L", r)),
      incendio: parseVal(cell("O", r)),
      indaqua:  parseVal(cell("R", r)),
      motor:    parseVal(cell("U", r)),
    });
  }

  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const isDryRun = process.argv.includes("--dry-run");

console.log("\n\x1b[35m╔══════════════════════════════════════════════════╗");
console.log("║   Seed Dívidas v2 — Fonte: Excel oficial        ║");
console.log("╚══════════════════════════════════════════════════╝\x1b[0m");
if (isDryRun) console.log("  \x1b[33m[DRY-RUN] Nenhuma alteração será feita.\x1b[0m\n");

async function main() {
  const excelPath = findExcel();
  console.log(`  \x1b[36m→ Excel: ${excelPath}\x1b[0m\n`);

  const excelRows = lerExcel(excelPath);
  console.log(`  \x1b[36m→ ${excelRows.length} frações lidas do Excel\x1b[0m`);

  // Validação obrigatória — Fração L
  const fracL = excelRows.find(r => r.numero === "L");
  if (!fracL) throw new Error("Fração L não encontrada no Excel — validação falhou");
  if (fracL.obras !== 2110.97)
    throw new Error(`Fração L obras_divida = ${fracL.obras}, esperado 2110.97 — validação falhou`);
  if (fracL.indaqua !== 250.56)
    throw new Error(`Fração L indaqua_divida = ${fracL.indaqua}, esperado 250.56 — validação falhou`);
  console.log("  \x1b[32m✓ Validação Fração L: obras=2110.97 | indaqua=250.56 — OK\x1b[0m\n");

  // Totais do Excel (relatório)
  const totalObras    = Math.round(excelRows.reduce((s, r) => s + r.obras,    0) * 100) / 100;
  const totalIncendio = Math.round(excelRows.reduce((s, r) => s + r.incendio, 0) * 100) / 100;
  const totalIndaqua  = Math.round(excelRows.reduce((s, r) => s + r.indaqua,  0) * 100) / 100;
  const totalMotor    = Math.round(excelRows.reduce((s, r) => s + r.motor,    0) * 100) / 100;

  console.log("  \x1b[36m────── Totais reais do Excel ──────\x1b[0m");
  console.log(`  obras_divida    : \x1b[33m${totalObras.toFixed(2)}\x1b[0m €`);
  console.log(`  incendio_divida : \x1b[33m${totalIncendio.toFixed(2)}\x1b[0m €`);
  console.log(`  indaqua_divida  : \x1b[33m${totalIndaqua.toFixed(2)}\x1b[0m €`);
  console.log(`  motor_divida    : \x1b[33m${totalMotor.toFixed(2)}\x1b[0m €`);
  console.log(`  TOTAL           : \x1b[31m${(totalObras + totalIncendio + totalIndaqua + totalMotor).toFixed(2)}\x1b[0m €\n`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const row of excelRows) {
    const { numero, obras, incendio, indaqua, motor } = row;

    // Ler valores actuais em BD
    const bdRow = await db.get<BdRow>(sql`
      SELECT obras_divida, incendio_divida, indaqua_divida, motor_divida
      FROM fracoes
      WHERE numero = ${numero}
      LIMIT 1
    `);

    if (!bdRow) {
      console.log(`  \x1b[31m✗ Fração ${numero.padEnd(4)} não encontrada na BD — ignorado\x1b[0m`);
      notFound++;
      continue;
    }

    const obras_bd    = Math.round((parseFloat(String(bdRow.obras_divida    ?? 0)) || 0) * 100) / 100;
    const incendio_bd = Math.round((parseFloat(String(bdRow.incendio_divida ?? 0)) || 0) * 100) / 100;
    const indaqua_bd  = Math.round((parseFloat(String(bdRow.indaqua_divida  ?? 0)) || 0) * 100) / 100;
    const motor_bd    = Math.round((parseFloat(String(bdRow.motor_divida    ?? 0)) || 0) * 100) / 100;

    const jaIgual =
      obras_bd    === obras    &&
      incendio_bd === incendio &&
      indaqua_bd  === indaqua  &&
      motor_bd    === motor;

    const linhaInfo = `obras=${obras} | incendio=${incendio} | indaqua=${indaqua} | motor=${motor}`;

    if (jaIgual) {
      console.log(`  \x1b[90m~ ${numero.padEnd(4)} já sync — ${linhaInfo}\x1b[0m`);
      skipped++;
      continue;
    }

    console.log(`  \x1b[32m✓ ${numero.padEnd(4)} → ${linhaInfo}\x1b[0m`);
    if (obras_bd + incendio_bd + indaqua_bd + motor_bd > 0) {
      console.log(`  \x1b[90m       BD antes: obras=${obras_bd} | incendio=${incendio_bd} | indaqua=${indaqua_bd} | motor=${motor_bd}\x1b[0m`);
    }

    if (!isDryRun) {
      await db.run(sql`
        UPDATE fracoes
        SET obras_divida    = ${obras},
            incendio_divida = ${incendio},
            indaqua_divida  = ${indaqua},
            motor_divida    = ${motor}
        WHERE numero = ${numero}
      `);
    }
    updated++;
  }

  // Zerar frações que o Excel não lista com dívida (garantir limpeza)
  if (!isDryRun) {
    const numerosComDivida = excelRows
      .filter(r => r.obras > 0 || r.incendio > 0 || r.indaqua > 0 || r.motor > 0)
      .map(r => `'${r.numero}'`)
      .join(", ");

    if (numerosComDivida.length > 0) {
      // Zerar frações que não estão na lista de devedores
      await db.run(sql`
        UPDATE fracoes
        SET obras_divida    = 0,
            incendio_divida = 0,
            indaqua_divida  = 0,
            motor_divida    = 0
        WHERE obras_divida > 0
           OR incendio_divida > 0
           OR indaqua_divida > 0
           OR motor_divida > 0
      `);
      // Re-aplicar os valores corretos do Excel
      for (const row of excelRows.filter(r => r.obras > 0 || r.incendio > 0 || r.indaqua > 0 || r.motor > 0)) {
        await db.run(sql`
          UPDATE fracoes
          SET obras_divida    = ${row.obras},
              incendio_divida = ${row.incendio},
              indaqua_divida  = ${row.indaqua},
              motor_divida    = ${row.motor}
          WHERE numero = ${row.numero}
        `);
      }
    }
  }

  console.log(`\n\x1b[36m────────────────────────────────────────────────────\x1b[0m`);
  if (isDryRun) {
    console.log(`  \x1b[33m[DRY-RUN] ${updated} fração(ões) seriam actualizadas | ${skipped} já OK | ${notFound} não encontradas\x1b[0m`);
  } else {
    console.log(`  \x1b[32m✓ ${updated} fração(ões) actualizadas | ${skipped} já OK | ${notFound} não encontradas\x1b[0m`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
