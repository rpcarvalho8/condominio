# F1 — Corpus multi-perfil

**ADR:** [ADR-044](ADR-LOG.md)  
**Perfil em execução:** `unit_share` ([F1-INGEST-EXEMPLOS](F1-INGEST-EXEMPLOS.md))  
**Perfil por ligar:** `budget_plan` — estes textos são o contrato de leitura futura. Nenhum é extraído nem confirmado neste slice. Não criam `AnnualBudget`, `Obligation`, `Payment` nem `Allocation`.

Treze documentos. Três são permilagem (`out_of_profile` para orçamento). Cinco seriam candidatos futuros de orçamento previsto. Cinco são falsos positivos: têm frações e euros, e não são o plano do ano. O mapa de dívidas é o falso positivo de referência.

A lista verificável no código é `ingest/profiles/corpus.ts`. Este ficheiro é a leitura humana.

## Fora do perfil `budget_plan` — já são `unit_share`

### 1. Tabela de permilagem

```text
codigo,permilagem
A,600
B,400
```

Quota-parte. Não é uma rubrica em euros.

### 2. Percentagem que o contexto converte para ‰

```text
Unidade,Percentagem
A,60
B,40
```

A conversão `percent_to_permille:*10` pertence a `unit_share` (ADR-043). Não é peso de uma despesa prevista.

### 3. Prosa de milésimas

```text
Fracção A ........ 600 milésimas
Fracção B ........ 400 milésimas
```

A pista `milésimas` fixa a unidade da quota-parte.

## Candidatos futuros de `budget_plan` — não implementados

Alinham com `BUDGET_LINE_KINDS` e com `annual_budget_lines` (`label`, `amountCents`). São previsão. `createAnnualBudget` continua a ser a escrita manual; `approveBudgetAndCreateObligations` continua a ser o único sítio que cria `Obligation`, e só depois das frações confirmadas.

### 4. Tabela de orçamento previsional

```text
Rubrica;Montante anual
Limpeza;8400
Seguro;2100
Fundo comum de reserva;1200
```

### 5. Blocos do ano

```text
Ano: 2026
Quota corrente: 12000 €
FCR: 1200 €
Extraordinária: 0 €
```

### 6. Prosa previsional

```text
Orçamento previsional de 2026. A quota corrente prevista é 12.000 €. O fundo comum de reserva previsto é 1.200 €.
```

«Prevista» não é valor em aberto.

### 7. Despesas previstas em markdown

```text
| Despesa prevista | Euros |
| --- | --- |
| Electricidade | 3600 |
| Manutenção do elevador | 1800 |
```

### 8. Rubrica extraordinária

```text
Trabalhos extraordinários previstos para 2026: pintura da fachada, 5.000 €.
```

A rubrica `extraordinaria` já existe no domínio. O documento não a aprova.

## Falsos positivos de `budget_plan`

Euros e códigos de fração não chegam. O perfil futuro tem de os recusar. O pipeline actual (`unit_share`) também não os promove a permilagem: não há pista de ‰ nem de percentagem.

### 9. Mapa de dívidas — falso positivo de referência

```text
Mapa de dívidas em 31 de Dezembro de 2025
Fracção A — 150,00 € em atraso
Fracção B — 80,00 € em atraso
```

Isto é dívida por fração. Não é o orçamento do ano, não é permilagem, não é `Payment`. O saldo em atraso, quando existir no produto, reconstrói-se no Ledger (F2).

### 10. Saldo por fração

```text
Saldo da fracção A: 150 € em dívida. Saldo da fracção B: 0 €.
```

Saldo não é rubrica previsional.

### 11. Pagamentos recebidos

```text
Pagamentos recebidos em Março. Fração A transferiu 85,00 € em 2026-03-04. Fração B transferiu 85,00 € em 2026-03-06.
```

Aproxima-se de `Payment` (F2). Receber dinheiro não liquida uma `Obligation` e não descreve o plano do ano.

### 12. Aviso de débito já emitido

```text
Aviso de débito. Fração A, quota corrente de Março de 2026, valor em aberto 85,00 €, vencimento 2026-03-08.
```

`Obligation` já nascida, ou `FinancialDocument`. Não é o orçamento que a originou.

### 13. Recibo com imputação

```text
Recibo 2026/014. Pagamento de 85,00 € da fração A imputado à quota corrente de Março.
```

`Payment` ligado a uma `Obligation` (`Allocation`). Fora de F1.

## O que este corpus não autoriza

Não ligar `kind=orcamento` ao pipeline. Não chamar `createAnnualBudget` nem `approveBudgetAndCreateObligations` a partir da ingestão. Não fundir o PR #31. Não acrescentar regex, agentes, F2, F4–F6, `FinancialTransaction`, nem redesenho de Authority ou Event Bus.
