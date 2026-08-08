// seed-quotas-extras.ts
// Popula quotas a partir das dívidas em fracoes.*_divida (só existem nesses campos).
// IDs determinísticos → onConflictDoNothing() evita duplicados em re-runs.
import { eq } from "drizzle-orm";
import { db } from "./index";
import { fracoes, quotas } from "./schema";

const PORTAO_TIPO_ID = "06d6dd01-04ac-4ea3-8359-ec705f78de7c";
const ELEV_TIPO_ID = "4696eef9-bd1f-46ff-a368-47cfd455eeca";
const INCENDIO_TIPO_ID = "dd16bd50-a2ab-4387-9d70-95822b1a61d7";

type QuotaSeed = {
  id: string;
  fracaoId: string;
  quotaTipoId?: string | null;
  tipo: string;
  mes: number;
  ano: number;
  valor: number;
  pago: boolean;
  observacoes: string;
  createdAt: Date;
};

async function seedQuotasExtras() {
  const activas = await db
    .select()
    .from(fracoes)
    .where(eq(fracoes.ativo, true));

  let obrasCriadas = 0;
  let extrasCriadas = 0;
  let totalValor = 0;

  for (const f of activas) {
    const entries: QuotaSeed[] = [];

    if ((f.obrasDivida ?? 0) > 0) {
      entries.push({
        id: `seed-obras-${f.id}`,
        fracaoId: f.id,
        tipo: "obras",
        valor: f.obrasDivida!,
        mes: 1,
        ano: 2026,
        pago: false,
        observacoes: "Derrama extraordinária obras — saldo em dívida Jun 2026",
        createdAt: new Date(),
      });
    }

    if ((f.incendioDivida ?? 0) > 0) {
      entries.push({
        id: `seed-incendio-${f.id}`,
        fracaoId: f.id,
        quotaTipoId: INCENDIO_TIPO_ID,
        tipo: "extra",
        valor: f.incendioDivida!,
        mes: 1,
        ano: 2026,
        pago: false,
        observacoes: "Quota extra incêndio — saldo em dívida Jun 2026",
        createdAt: new Date(),
      });
    }

    if ((f.indaquaDivida ?? 0) > 0) {
      entries.push({
        id: `seed-indaqua-${f.id}`,
        fracaoId: f.id,
        quotaTipoId: ELEV_TIPO_ID,
        tipo: "extra",
        valor: f.indaquaDivida!,
        mes: 1,
        ano: 2026,
        pago: false,
        observacoes: "Quota extra Indaqua/elevadores — saldo em dívida Jun 2026",
        createdAt: new Date(),
      });
    }

    if ((f.motorDivida ?? 0) > 0) {
      entries.push({
        id: `seed-motor-${f.id}`,
        fracaoId: f.id,
        quotaTipoId: PORTAO_TIPO_ID,
        tipo: "extra",
        valor: f.motorDivida!,
        mes: 1,
        ano: 2026,
        pago: false,
        observacoes: "Quota extra motor garagem — saldo em dívida Jun 2026",
        createdAt: new Date(),
      });
    }

    for (const entry of entries) {
      const inserted = await db
        .insert(quotas)
        .values(entry)
        .onConflictDoNothing()
        .returning({ id: quotas.id });

      if (inserted.length === 0) continue;

      if (entry.tipo === "obras") obrasCriadas++;
      else extrasCriadas++;
      totalValor += entry.valor;
    }
  }

  console.log("✅ Seed quotas extras concluído");
  console.log(`   Quotas obras criadas:  ${obrasCriadas}`);
  console.log(`   Quotas extra criadas:  ${extrasCriadas}`);
  console.log(`   Total valor inserido:  ${totalValor.toFixed(2)}€`);
}

seedQuotasExtras().catch(console.error);
