# F2 — Estado de implementação (Finance Kernel slice)

**Branch:** `cursor/f2-financeiro-ledger-1c40`  
**Base documental:** `docs/lumen/06-FATIAS.md`, ADR-003, ADR-012, ADR-028, ADR-029

## Posição face ao plano

O plano (`06-FATIAS.md`) distingue:

1. **Finance Kernel** — Obligation / Payment / Allocation / Ledger / SettlementPolicy / AccountingPeriod / cash / hash-chain  
2. **Enable Banking** — *só depois* do Finance Kernel passar testes adversariais (ordem de execução §8)  
3. **Critério de conclusão F2** — sync bancário **ou** aviso proactivo de reautorização, Payments candidatos, Allocation + hash-chain, cash 3 estados, avisos dia 1, recibos na confirmação, `generated_from`

**Este PR entrega o Finance Kernel (1).** Não fecha ainda o critério completo (3): faltam aviso/sync bancário e jobs de avisos/recibos. Isso não é “opcional como LLM na F1”; fica como trabalho F2 seguinte, após este kernel.

## Fronteira dura (este slice)

- **Não substitui** o modelo Fonte `Quota.pago` / `routes/quotas` / reconciliação Enable Banking. O kernel F2 coexiste; dual-write e cutover da Fonte são trabalho posterior.
- **Não é o critério F2 completo** (sync ou aviso de reautorização, Payments candidatos, jobs avisos/recibos).
- Hash-chain = deteção de adulteração (ADR-029), não imutabilidade absoluta.
- `f2_bank_movements` é evidência tenant-scoped para cash `bank_deposit` / `deposited` — **não** o ciclo de vida bancário completo.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| `Obligation` (origem F1) | ✅ | Reutiliza orçamento aprovado |
| `Payment` + `allocation_status` (ADR-012) | ✅ | Válido sem Allocation; ortogonal a cash |
| Cash `registered → verified → deposited` (ADR-028) | ✅ | Fiscalizacao `second_person`; `bank_deposit`/`deposited` exigem movimento tenant-scoped |
| Cash `registered` não liquida Obligation | ✅ | |
| `SettlementPolicy` + `legal_basis` | ✅ | Seed default |
| `Allocation` → `LedgerEntry` hash-chain (ADR-029) | ✅ | Mutex por tenant + `BEGIN IMMEDIATE`; retry unique `(tenant_id, sequence)`; `open_amount >=` |
| `AccountingPeriod` open/close | ✅ | |
| `PaymentNotice` / `Receipt` + `generated_from` | ✅ | 1 recibo/payment; notice valida tenant+fração+montante |
| Rotas `/api/f2/*` + migration `0006` | ✅ | `applyF2FinanceSchema` |

## Ainda em falta para o critério F2 (próximo trabalho)

| Item do critério / tabela F2 | Estado |
|---|---|
| Sync bancário **ou** aviso proactivo de reautorização | ❌ |
| Payments candidatos via reconciliação / CSV / identity-matrix | ❌ |
| Job avisos dia 1 / recibos na confirmação (calendário/sweep) | ❌ (API de emissão existe; jobs não) |
| Account Statement sob pedido | ❌ |
| Enable Banking PSD2 completo | ❌ (depois dos testes adversariais do kernel) |
| UI admin | ❌ |
| Portal saldo | F3 |

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2
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
