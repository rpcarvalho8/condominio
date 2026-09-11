# F2 — Estado de implementação (vertical slice)

**Branch:** `cursor/f2-financeiro-ledger-1c40`  
**Base documental:** `docs/lumen/06-FATIAS.md`, ADR-003, ADR-012, ADR-028, ADR-029

## Âmbito deste slice (o que o plano exige no kernel)

Espelha a abordagem F1: fatia vertical testável no kernel, **sem** transplantar toda a lista F2 de uma vez.

| Capacidade (docs/lumen) | Estado | Notas |
|---|---|---|
| `Obligation` (origem F1) | ✅ | Reutiliza orçamento aprovado; nunca criar por algoritmo solto |
| `Payment` + `allocation_status` (ADR-012) | ✅ | Válido sem Allocation; ortogonal a `cash_status` |
| Dinheiro `registered → verified → deposited` (ADR-028) | ✅ | Evidência fotográfica obrigatória no registo |
| `second_person`: registante ≠ verificador | ✅ | `bank_deposit` também suportado |
| Cash `registered` **não** liquida Obligation | ✅ | Allocate bloqueado até verified/deposited |
| `SettlementPolicy` versionada + `legal_basis` | ✅ | Seed `default` (dívida → FCR → quota → extraordinária) |
| `Allocation` → `LedgerEntry` hash-chain (ADR-029) | ✅ | SHA-256 `sha256-v1`; génese por tenant; serialização canónica |
| Cadeia quebrada → bloqueio + AuditEvent | ✅ | Sem rewrite silencioso |
| `AccountingPeriod` open/close | ✅ | Fecho com AuditEvent |
| `PaymentNotice` / `Receipt` + `generated_from` (ADR-016) | ✅ | Recibo nunca vazio |
| Audit + domain events | ✅ | `payment.registered` / `PaymentAllocated` / rutura de cadeia |
| Rotas `/api/f2/*` | ✅ | Membership + manager (padrão F1) |
| Migration `0006_f2_finance.sql` | ✅ | Via `applyF2FinanceSchema` |

## Explicitamente fora deste slice

(Itens da tabela F2 em `06-FATIAS.md` que **não** fazem parte desta fatia — ficam para iterações seguintes, como LLM/OCR ficou fora de F1.)

- Enable Banking / PSD2 + lifecycle `condo_bank_connections` (tabela existe; sync real não)
- `reconciliation-engine` / CSV multi-banco / `identity-matrix` / LLM fallback match
- Jobs calendário `GenerateMonthlyPaymentNotices` / receipts sweep
- UI admin de caixa / ledger / fecho de mês
- Reparação operacional de cadeia (só deteção + bloqueio nesta fatia)
- Portal condómino saldo (F3)
- `Quota.pago: boolean` — **não** regressar a este modelo

## Como testar

```bash
cd packages/web && bun run test:f2
# ou
cd packages/web && bun test src/api/f2.integration.test.ts
```

## API (resumo)

- `POST /api/f2/payments`
- `POST /api/f2/payments/:id/verify-cash`
- `POST /api/f2/payments/:id/deposit-cash`
- `POST /api/f2/payments/:id/allocate`
- `POST /api/f2/payments/:id/receipt`
- `POST /api/f2/ledger/validate`
- `POST /api/f2/periods/open`
- `POST /api/f2/periods/close`
- `POST /api/f2/documents/payment-notice`
