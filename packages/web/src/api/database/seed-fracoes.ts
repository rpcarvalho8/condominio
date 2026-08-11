// seed-fracoes.ts
// Popula / actualiza a tabela `fracoes` a partir de identify-data.json (repo root).
// Upsert por `numero` (= idFracao): preserva UUIDs existentes; insere IDs estáveis se faltarem.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { fracoes } from "./schema";
import type { FracaoIdentidade } from "../lib/identity-matrix";

// packages/web/src/api/database → 5 níveis até à raiz do repo
const IDENTIFY_DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../identify-data.json",
);

interface IdentifyDataFile {
  fracoes: FracaoIdentidade[];
}

const identifyData: IdentifyDataFile = JSON.parse(
  readFileSync(IDENTIFY_DATA_PATH, "utf-8"),
);
const FRACOES_SOURCE = identifyData.fracoes;

function mapTipo(tipo: FracaoIdentidade["tipo"]): string {
  if (tipo === "habitacao") return "apartamento";
  return tipo; // loja | garagem
}

function mapRow(m: FracaoIdentidade) {
  const quotaMensal = Math.round(
    (m.valoresFixos.condominio + m.valoresFixos.fundoReserva) * 100,
  ) / 100;

  return {
    numero: m.idFracao,
    proprietarioNome: m.nomeProprietario,
    tipo: mapTipo(m.tipo),
    permilagem: m.permilagem,
    quotaMensal,
    obrasDivida: m.dividasAtuais.obras,
    incendioDivida: m.dividasAtuais.incendio,
    indaquaDivida: m.dividasAtuais.indaqua,
    motorDivida: m.dividasAtuais.motor,
    ibansConhecidos: JSON.stringify(m.ibansConhecidos ?? []),
    notas: `${m.entrada} · ${m.descricao}`,
    ativo: true,
  };
}

async function seedFracoes() {
  const existentes = await db
    .select({ id: fracoes.id, numero: fracoes.numero })
    .from(fracoes);
  const idByNumero = new Map(
    existentes
      .filter((r) => r.numero)
      .map((r) => [r.numero!.toUpperCase(), r.id]),
  );

  let inserted = 0;
  let updated = 0;

  for (const m of FRACOES_SOURCE) {
    const row = mapRow(m);
    const key = m.idFracao.toUpperCase();
    const existingId = idByNumero.get(key);

    if (existingId) {
      await db
        .update(fracoes)
        .set(row)
        .where(eq(fracoes.id, existingId));
      updated++;
    } else {
      await db.insert(fracoes).values({
        id: `seed-fracao-${m.idFracao}`,
        ...row,
        createdAt: new Date(),
      });
      inserted++;
    }
  }

  console.log("✅ Seed frações concluído");
  console.log(`   Fonte: identify-data.json (${FRACOES_SOURCE.length} registos)`);
  console.log(`   Inseridas: ${inserted}`);
  console.log(`   Actualizadas: ${updated}`);
}

seedFracoes().catch((e) => {
  console.error("❌ seed-fracoes falhou:", e);
  process.exit(1);
});
