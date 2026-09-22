/**
 * Corpus documental do ADR-044. Não é um extractor.
 * Os veredictos descrevem o perfil futuro budget_plan; nenhum exemplo é confirmado.
 */
export type CorpusBudgetVerdict = "out_of_profile" | "future_candidate" | "false_positive";

export type CorpusExample = {
  id: string;
  title: string;
  budgetPlanVerdict: CorpusBudgetVerdict;
  text: string;
  note: string;
};

export const F1_PROFILE_CORPUS: CorpusExample[] = [
  {
    id: "01-unit-share-csv",
    title: "Tabela de permilagem",
    budgetPlanVerdict: "out_of_profile",
    text: "codigo,permilagem\nA,600\nB,400\n",
    note: "Perfil unit_share. Já coberto por F1-INGEST-EXEMPLOS. Não é orçamento.",
  },
  {
    id: "02-unit-share-percent",
    title: "Percentagem de permilagem",
    budgetPlanVerdict: "out_of_profile",
    text: "Unidade,Percentagem\nA,60\nB,40\n",
    note: "unit_share converte para ‰ só com contexto (soma 100). Não é uma rubrica de orçamento.",
  },
  {
    id: "03-unit-share-prose",
    title: "Prosa de milésimas",
    budgetPlanVerdict: "out_of_profile",
    text: "Fracção A ........ 600 milésimas\nFracção B ........ 400 milésimas\n",
    note: "unit_share. A pista milésimas fixa a quota-parte, não um euro previsto.",
  },
  {
    id: "04-budget-table",
    title: "Tabela de orçamento previsional",
    budgetPlanVerdict: "future_candidate",
    text: [
      "Rubrica;Montante anual",
      "Limpeza;8400",
      "Seguro;2100",
      "Fundo comum de reserva;1200",
      "",
    ].join("\n"),
    note: "Candidato futuro de budget_plan (label + importância prevista). Esta fase não extrai nem grava annual_budget_lines.",
  },
  {
    id: "05-budget-key-value",
    title: "Blocos do orçamento do ano",
    budgetPlanVerdict: "future_candidate",
    text: ["Ano: 2026", "Quota corrente: 12000 €", "FCR: 1200 €", "Extraordinária: 0 €", ""].join(
      "\n",
    ),
    note: "As rubricas coincidem com BUDGET_LINE_KINDS. Continua a ser previsão, não Obligation.",
  },
  {
    id: "06-budget-prose",
    title: "Prosa de orçamento previsional",
    budgetPlanVerdict: "future_candidate",
    text: "Orçamento previsional de 2026. A quota corrente prevista é 12.000 €. O fundo comum de reserva previsto é 1.200 €.\n",
    note: "Previsto ≠ valor que a fração já deve. approveBudgetAndCreateObligations é outro passo, manual, com frações confirmadas.",
  },
  {
    id: "07-budget-markdown",
    title: "Tabela markdown de despesas previstas",
    budgetPlanVerdict: "future_candidate",
    text: "| Despesa prevista | Euros |\n| --- | --- |\n| Electricidade | 3600 |\n| Manutenção do elevador | 1800 |\n",
    note: "Grelha de despesas do ano. Não é mapa de unidades nem lista de pagamentos.",
  },
  {
    id: "08-budget-extraordinaria",
    title: "Rubrica extraordinária prevista",
    budgetPlanVerdict: "future_candidate",
    text: "Trabalhos extraordinários previstos para 2026: pintura da fachada, 5.000 €.\n",
    note: "Alinha com a rubrica extraordinaria já aceite em createAnnualBudget. Não cria a Obligation.",
  },
  {
    id: "09-debt-map",
    title: "Mapa de dívidas",
    budgetPlanVerdict: "false_positive",
    text: [
      "Mapa de dívidas em 31 de Dezembro de 2025",
      "Fracção A — 150,00 € em atraso",
      "Fracção B — 80,00 € em atraso",
      "",
    ].join("\n"),
    note: "FALSO POSITIVO de budget_plan. Dívida por fração não é orçamento previsto, nem permilagem, nem Payment.",
  },
  {
    id: "10-balance-sheet",
    title: "Saldo por fração",
    budgetPlanVerdict: "false_positive",
    text: "Saldo da fracção A: 150 € em dívida. Saldo da fracção B: 0 €.\n",
    note: "Saldo/dívida reconstrói-se no Ledger (F2). Não é uma rubrica previsional.",
  },
  {
    id: "11-payments",
    title: "Lista de pagamentos recebidos",
    budgetPlanVerdict: "false_positive",
    text: "Pagamentos recebidos em Março. Fração A transferiu 85,00 € em 2026-03-04. Fração B transferiu 85,00 € em 2026-03-06.\n",
    note: "Isto aproxima-se de Payment (F2). Não é orçamento e não liquida Obligation por si.",
  },
  {
    id: "12-obligation-notice",
    title: "Aviso de débito já emitido",
    budgetPlanVerdict: "false_positive",
    text: "Aviso de débito. Fração A, quota corrente de Março de 2026, valor em aberto 85,00 €, vencimento 2026-03-08.\n",
    note: "Obligation já nascida, ou FinancialDocument. Não é o orçamento que a originou.",
  },
  {
    id: "13-allocation-receipt",
    title: "Recibo com imputação",
    budgetPlanVerdict: "false_positive",
    text: "Recibo 2026/014. Pagamento de 85,00 € da fração A imputado à quota corrente de Março.\n",
    note: "Payment já ligado a uma Obligation (Allocation). Fora de F1 e fora de budget_plan.",
  },
];

export function corpusExample(id: string): CorpusExample {
  const found = F1_PROFILE_CORPUS.find((example) => example.id === id);
  if (!found) throw new Error(`exemplo em falta: ${id}`);
  return found;
}
