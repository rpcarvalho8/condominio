/**
 * cativo-rules.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Regras de identificação de fundos "cativos" na Conta à Ordem.
 *
 * "Cativo" = dinheiro que já entrou no saldo bancário da Conta à Ordem,
 * mas é legalmente destinado a uma gaveta específica (Fundo de Reserva,
 * INDAQUA, Incêndio, Motor da Garagem, Obras) e ainda não foi transferido
 * fisicamente para a conta a prazo respectiva.
 *
 * Estas regras aplicam-se sobre os campos de texto dos movimentos bancários:
 *   - description  (remittance_information da Enable Banking / Santander)
 *   - debtorName   (nome do pagador)
 *   - creditorName (nome do credor — normalmente não relevante para entradas)
 *
 * COMO ATUALIZAR:
 *   Para adicionar novas palavras-chave, edita o array `patterns` da regra
 *   correspondente. Para adicionar IBANs de remetentes conhecidos, usa o array
 *   `ibansSender`. Não precisas de tocar em nenhum outro ficheiro.
 *
 * GAVETAS DISPONÍVEIS (devem corresponder às chaves em SALDO_DEFAULTS):
 *   "fundo_reserva" | "indaqua" | "incendio" | "portao" | "obras"
 * ────────────────────────────────────────────────────────────────────────────
 */

export type GavetaCativo =
  | "fundo_reserva"
  | "indaqua"
  | "incendio"
  | "portao"
  | "obras";

export interface RegraCativo {
  /** Identificador da gaveta destino */
  gaveta: GavetaCativo;
  /** Label legível para logs e UI */
  label: string;
  /**
   * Padrões Regex testados sobre `description` e `debtorName` (case-insensitive).
   * Basta um match para classificar o movimento.
   */
  patterns: RegExp[];
  /**
   * IBANs de remetentes conhecidos para esta gaveta.
   * Útil quando o descritivo não é conclusivo mas o IBAN do pagador é fixo.
   * Comparação normalizada (espaços removidos, maiúsculas).
   */
  ibansSender?: string[];
}

/**
 * REGRAS_CATIVO — fonte única de verdade para classificação de movimentos cativos.
 *
 * Ordem de avaliação: primeira regra que fizer match vence (não acumula).
 * Coloca regras mais específicas antes das genéricas.
 */
export const REGRAS_CATIVO: RegraCativo[] = [
  // ── 1. FUNDO DE RESERVA ──────────────────────────────────────────────────
  // Pagadores que identificam explicitamente que a transferência é para o FR.
  {
    gaveta: "fundo_reserva",
    label: "Fundo de Reserva",
    patterns: [
      /fundo\s+de?\s+reserva/i,
      /\bF\.?R\.?\b/,               // "FR", "F.R.", "F.R" no descritivo
      /quota\s+reserva/i,
      /reserva\s+condom/i,
      /fundo\s+reserva/i,
    ],
  },

  // ── 2. INDAQUA (Quota Extra Elevadores / Serviço Água) ────────────────────
  // Pagamentos específicos de serviço INDAQUA ou quota extra de água.
  {
    gaveta: "indaqua",
    label: "INDAQUA / Elevadores",
    patterns: [
      /indaqua/i,
      /\bINDAQUA\b/i,
      /água\s+extra/i,
      /agua\s+extra/i,
      /quota\s+(extra\s+)?elevador/i,
      /cota\s+(extra\s+)?elevador/i,
    ],
  },

  // ── 3. INCÊNDIO (Seguro / Obras Incêndio) ────────────────────────────────
  {
    gaveta: "incendio",
    label: "Incêndio / Seguro",
    patterns: [
      /inc[eê]ndio/i,
      /seguro\s+(incendio|inc[eê]ndio|multi[- ]?riscos|multiriscos)/i,
      /obras?\s+inc[eê]ndio/i,
      /quota\s+inc[eê]ndio/i,
      /cota\s+inc[eê]ndio/i,
    ],
  },

  // ── 4. MOTOR DA GARAGEM (Portão) ─────────────────────────────────────────
  // "Portão", "Garagem", "Motor" — pagamentos da cota extra do portão.
  // Nota: evitar match em "garagem" genérico de moradas — exige contexto extra.
  {
    gaveta: "portao",
    label: "Motor da Garagem / Portão",
    patterns: [
      /motor\s+(da\s+)?garagem/i,
      /port[aã]o\s+(garagem|motor)/i,
      /cota\s+(extra\s+)?motor/i,
      /quota\s+(extra\s+)?motor/i,
      /cota\s+(extra\s+)?port[aã]o/i,
      /quota\s+(extra\s+)?port[aã]o/i,
      /\bAH\s+cota\s+extra/i,       // referência específica fração AH (histórico)
      /\bAI\s+cota\s+extra/i,       // referência específica fração AI (histórico)
    ],
  },

  // ── 5. OBRAS ─────────────────────────────────────────────────────────────
  // Pagamentos de obras gerais do condomínio (não portão).
  {
    gaveta: "obras",
    label: "Obras Condomínio",
    patterns: [
      /\bobras?\b/i,
      /fundo\s+(de?\s+)?obras/i,
      /quota\s+obras/i,
      /cota\s+obras/i,
      /reparac[aã]o/i,
      /reabilitac[aã]o/i,
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Tipo de retorno do parser
// ────────────────────────────────────────────────────────────────────────────

export interface ResultadoIdentificacao {
  /** null = não é cativo (quota corrente ou despesa normal) */
  gaveta: GavetaCativo | null;
  label: string | null;
  /** Qual campo fez match */
  matchedField: "description" | "debtorName" | "ibanSender" | null;
  /** Padrão que fez match (para debug/logs) */
  matchedPattern: string | null;
}

/**
 * identificarDestinoCativo
 * ────────────────────────────────────────────────────────────────────────────
 * Analisa os campos de texto de um movimento bancário e determina se o valor
 * deve ser classificado como "cativo" numa gaveta específica.
 *
 * @param description   Campo de remittance/descrição do movimento
 * @param debtorName    Nome do pagador (para entradas CRDT)
 * @param ibanSender    IBAN do remetente (opcional — se disponível na API)
 *
 * @returns ResultadoIdentificacao — gaveta=null se não for cativo
 *
 * @example
 *   const r = identificarDestinoCativo(
 *     "Transferencia - Fundo de Reserva Jan 2026",
 *     "João Silva",
 *   );
 *   // → { gaveta: "fundo_reserva", label: "Fundo de Reserva", ... }
 */
export function identificarDestinoCativo(
  description: string | null | undefined,
  debtorName: string | null | undefined,
  ibanSender?: string | null,
): ResultadoIdentificacao {
  const desc = (description ?? "").trim();
  const debtor = (debtorName ?? "").trim();
  const iban = (ibanSender ?? "").replace(/\s/g, "").toUpperCase();

  for (const regra of REGRAS_CATIVO) {
    // 1. Testar IBANs conhecidos primeiro (mais fiável)
    if (iban && regra.ibansSender?.length) {
      for (const ibanRef of regra.ibansSender) {
        const ibanRefNorm = ibanRef.replace(/\s/g, "").toUpperCase();
        if (iban === ibanRefNorm) {
          return {
            gaveta: regra.gaveta,
            label: regra.label,
            matchedField: "ibanSender",
            matchedPattern: ibanRef,
          };
        }
      }
    }

    // 2. Testar patterns sobre description
    if (desc) {
      for (const pattern of regra.patterns) {
        if (pattern.test(desc)) {
          return {
            gaveta: regra.gaveta,
            label: regra.label,
            matchedField: "description",
            matchedPattern: pattern.toString(),
          };
        }
      }
    }

    // 3. Testar patterns sobre debtorName
    if (debtor) {
      for (const pattern of regra.patterns) {
        if (pattern.test(debtor)) {
          return {
            gaveta: regra.gaveta,
            label: regra.label,
            matchedField: "debtorName",
            matchedPattern: pattern.toString(),
          };
        }
      }
    }
  }

  return { gaveta: null, label: null, matchedField: null, matchedPattern: null };
}
