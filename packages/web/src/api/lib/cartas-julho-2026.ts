/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║        CARTAS DE COBRANÇA — JULHO 2026                          ║
 * ║  Fonte: BD (`configuracoes.cartas_julho_2026`) ou ficheiro local ║
 * ║  gitignored `cartas-julho-data.json`. Sem PII no código-fonte.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * REGRA DE AMORTIZAÇÃO (cascade):
 *   Regra A — descritor explícito: débito directo à rubrica nomeada
 *   Regra B — sem descritor:
 *     1.º Quota Condomínio Geral
 *     2.º Fundo de Reserva
 *     3.º Cotas Extras (Obras → Elevadores → Motor → Incêndio)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export interface CartaFracao {
  /** Número/letra da fração (ex: "AA", "G", "L") */
  fracao: string;
  /** Nome do proprietário conforme carta */
  proprietario: string;
  /** Quota mensal Condomínio Geral (julho 2026) */
  quotaJulho: number;
  /** Fundo de Reserva (julho 2026) */
  fundoReservaJulho: number;
  /** Dívida Obras (quota extra) — acumulado até carta */
  obras: number;
  /** Dívida Incêndio (quota extra) — acumulado até carta */
  incendio: number;
  /** Dívida Motor/Portão (quota extra) — acumulado até carta */
  motor: number;
  /** Quotas de condomínio em atraso (meses anteriores) */
  quotasCC_atraso: number;
  /** Multas aplicadas */
  multas: number;
  /** TOTAL da carta emitida (soma de todas as rubricas) */
  totalCarta: number;
  /** True se esta é a carta de junho (fração L) e não julho */
  isCartaJunho?: boolean;
}

function loadCartasFromLocalFile(): CartaFracao[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // lib → api → src → web → packages → repo root
    const candidates = [
      resolve(here, "../../../../../cartas-julho-data.json"),
      resolve(process.cwd(), "cartas-julho-data.json"),
      resolve(process.cwd(), "../../cartas-julho-data.json"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const list = Array.isArray(raw) ? raw : raw.cartas;
      if (Array.isArray(list) && list.length > 0) return list as CartaFracao[];
    }
  } catch (e) {
    console.warn("[cartas] falha ao ler cartas-julho-data.json:", e);
  }
  return [];
}

/**
 * Cache mutável — arranca do ficheiro local (gitignored) se existir.
 * Preferir `setCartasFromDB()` / seed-gdpr-config após boot.
 */
export let CARTAS_JULHO_2026: CartaFracao[] = loadCartasFromLocalFile();

/** Substitui o cache (ex.: após ler `configuracoes`). */
export function setCartasFromDB(cartas: CartaFracao[]): void {
  CARTAS_JULHO_2026 = Array.isArray(cartas) ? cartas : [];
}

/**
 * Lookup por número de fração (case-insensitive).
 * Retorna undefined se não emitida (fração em dia).
 */
export function getCartaFracao(fracao: string): CartaFracao | undefined {
  const upper = fracao.toUpperCase().trim();
  return CARTAS_JULHO_2026.find(c => c.fracao.toUpperCase() === upper);
}

/**
 * Total geral "Por Receber" de todas as cartas emitidas.
 * Soma os totalCarta de todas as frações com carta emitida.
 */
export function totalGeralCartas(): number {
  return Math.round(
    CARTAS_JULHO_2026.reduce((s, c) => s + c.totalCarta, 0) * 100
  ) / 100;
}

/**
 * Constrói um DividaFracao a partir dos dados da carta para uma fração.
 * Usado como fonte de verdade em substituição do cálculo permilagem × orçamento.
 */
export function dividaDaCartaFracao(fracao: string): {
  obras: number;
  motor: number;
  incendio: number;
  elevadores: number;
  quotasCC_atraso: number;
  multas: number;
  totalCarta: number;
} {
  const carta = getCartaFracao(fracao);
  if (!carta) {
    return { obras: 0, motor: 0, incendio: 0, elevadores: 0, quotasCC_atraso: 0, multas: 0, totalCarta: 0 };
  }
  return {
    obras:           carta.obras,
    motor:           carta.motor,
    incendio:        carta.incendio,
    elevadores:      0, // elevadores embutidos em motor/carta (INDAQUA separado)
    quotasCC_atraso: carta.quotasCC_atraso,
    multas:          carta.multas,
    totalCarta:      carta.totalCarta,
  };
}

type MorosoEntry = { fracao: string; proprietario: string; total: number };

/**
 * Lista de frações com cartas emitidas agrupadas por rubrica morosa.
 * Conveniente para alimentar os morosos de cada secção do dashboard.
 */
export function morososPorRubrica(): {
  obras:         MorosoEntry[];
  incendio:      MorosoEntry[];
  motor:         MorosoEntry[];
  contaCorrente: MorosoEntry[];
} {
  const obras:    MorosoEntry[] = [];
  const incendio: MorosoEntry[] = [];
  const motor:    MorosoEntry[] = [];
  const cc:       MorosoEntry[] = [];

  for (const c of CARTAS_JULHO_2026) {
    if (c.obras > 0)           obras.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.obras });
    if (c.incendio > 0)        incendio.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.incendio });
    if (c.motor > 0)           motor.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.motor });
    if (c.quotasCC_atraso > 0) cc.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.quotasCC_atraso });
  }

  const byTotalDesc = (a: MorosoEntry, b: MorosoEntry) => b.total - a.total;
  obras.sort(byTotalDesc);
  incendio.sort(byTotalDesc);
  motor.sort(byTotalDesc);
  cc.sort(byTotalDesc);

  return { obras, incendio, motor, contaCorrente: cc };
}
