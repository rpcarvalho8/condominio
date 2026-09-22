/**
 * Perfil budget_plan — só contratos (ADR-044).
 *
 * Não há extract, confirm, nem chamada a createAnnualBudget / approveBudgetAndCreateObligations.
 * kind=orcamento não entra em runIngestPipeline.
 *
 * O candidato futuro alinha-se com o que o domínio já persiste à mão
 * (annual_budgets / annual_budget_lines). Não é Obligation, Payment,
 * Allocation, dívida nem saldo.
 */
import {
  BUDGET_LINE_KINDS,
  EXTRACT_LINE_KINDS,
  INGEST_DOCUMENT_KINDS,
} from "../../../../domain/constitution";
import type { FieldEvidence, ReviewState } from "../shared";
import { INGEST_PROFILE_IDS } from "../shared";

export const BUDGET_PLAN_PROFILE_ID = INGEST_PROFILE_IDS.budgetPlan;

/** Fase B: contratos e documentação. O pipeline não instancia este perfil. */
export const BUDGET_PLAN_PHASE = "contracts_only" as const;

export const BUDGET_PLAN_DOCUMENT_KIND = INGEST_DOCUMENT_KINDS.orcamento;
export const BUDGET_PLAN_EXTRACT_KIND = EXTRACT_LINE_KINDS.budgetLine;

/** Rubricas já aceites por createAnnualBudget. Não são tipos de Obligation novos. */
export const BUDGET_PLAN_LINE_KINDS = BUDGET_LINE_KINDS;

export const BUDGET_PLAN_FIELDS = {
  kind: "kind",
  label: "label",
  amountCents: "amount_cents",
} as const;

export type BudgetPlanField = (typeof BUDGET_PLAN_FIELDS)[keyof typeof BUDGET_PLAN_FIELDS];

export type BudgetPlanLineKind = (typeof BUDGET_LINE_KINDS)[keyof typeof BUDGET_LINE_KINDS];

/**
 * Linha de orçamento previsto, se um dia o perfil for ligado.
 * year + kind + label + amountCents são os campos de annual_budgets / annual_budget_lines.
 * amountCents null = a importância ou a unidade monetária não está identificada.
 */
export type BudgetPlanCandidate = {
  profile: typeof BUDGET_PLAN_PROFILE_ID;
  year: number | null;
  kind: BudgetPlanLineKind | null;
  label: string;
  amountCents: number | null;
  evidence: Array<FieldEvidence<BudgetPlanField>>;
  review: ReviewState;
};

/** O que um documento com euros e códigos de fração não pode ser promovido a ser. */
export const BUDGET_PLAN_DOES_NOT_CREATE = [
  "annual_budget",
  "annual_budget_line",
  "obligation",
  "payment",
  "allocation",
  "ledger_entry",
  "debt_balance",
] as const;
