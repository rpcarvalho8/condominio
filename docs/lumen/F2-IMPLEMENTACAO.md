# F2 — Estado de implementação (Finance Kernel slice)

**Branch:** `cursor/f2-criterio-candidatos-jobs-reauth`  
**Base documental:** `docs/lumen/06-FATIAS.md`, ADR-003, ADR-012, ADR-014, ADR-028, ADR-029

## Posição face ao plano

O plano (`06-FATIAS.md`) distingue:

1. **Finance Kernel** — Obligation / Payment / Allocation / Ledger / SettlementPolicy / AccountingPeriod / cash / hash-chain  
2. **Enable Banking** — *só depois* do Finance Kernel passar testes adversariais (ordem de execução §8)  
3. **Critério de conclusão F2** — sync bancário **ou** aviso proactivo de reautorização, Payments candidatos, Allocation + hash-chain, cash 3 estados, avisos dia 1, recibos na confirmação, `generated_from`

**Este PR fecha o critério F2 (3) no kernel**, sem Enable Banking PSD2 (2). O aviso proactivo de reautorização é o ramo escolhido do “sync **ou** aviso”; sync completo fica para o slice PSD2.

## Fronteira dura (este slice)

- **Não substitui** o modelo Fonte `Quota.pago` / `routes/quotas` / reconciliação Enable Banking. O kernel F2 coexiste; dual-write e cutover da Fonte são trabalho posterior.
- Payments candidatos **nunca** marcam `Quota.pago=true` no caminho feliz.
- Hash-chain = deteção de adulteração (ADR-029), não imutabilidade absoluta.
- `f2_bank_movements` é evidência tenant-scoped (cash deposit **e** créditos candidatos) — **não** o ciclo PSD2 completo.
- `BankConnection` liga-se à **conta do condomínio** (IBAN + ASPSP), não à pessoa do admin (ADR-014).

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
| `PaymentNotice` / `Receipt` + `generated_from` | ✅ | 1 recibo/payment; notice valida tenant+fração+**soma `openAmountCents`** |
| Rotas `/api/f2/*` + migration `0006`/`0007` | ✅ | `applyF2FinanceSchema`; UNIQUE `(tenant_id, external_ref)` em `payments` e `f2_bank_movements` |
| Aviso proactivo de reautorização `BankConnection` | ✅ | Lead 14 dias; outbox `notify.bank_reauth` para o **email** da Person da Membership Admin/gestor activa (`adminEmail` no payload); fallback `admin@invalid`; **nunca** o IBAN; `authorizedByMembershipId` validado (activo + tenant + papel gestor) |
| Payments candidatos (CSV / reconciliação / identity-matrix) | ✅ | `identificado` ou `nao_alocado_pendente`; ingest transaccional + idempotente em conflito UNIQUE; match de nome por **tokens/palavras completas** (ANA ≠ JOANA/MARIANA); sem Allocation automática; sem `Quota.pago`; `POST /payments/candidates` rejeita `csvText` > 512k chars e `movements[]` > 500 |
| Job avisos dia 1 (UTC) | ✅ | `GenerateMonthlyPaymentNotices` → `issuePaymentNotice` com montante = aberto restante |
| Recibos na confirmação de Allocation + sweep | ✅ | Outbox `f2.issue_receipt` + `/jobs/receipt-sweep` |

## Critério F2 — o que fecha aqui vs o que fica

| Item do critério / tabela F2 | Estado neste PR |
|---|---|
| Sync bancário **ou** aviso proactivo de reautorização | ✅ aviso proactivo (`BANK_REAUTH_LEAD_DAYS = 14`) |
| Payments candidatos via reconciliação / CSV / identity-matrix | ✅ kernel; transplante de parsers **sem** mapas Fonte hardcoded |
| Allocation + hash-chain | ✅ (PR anterior) |
| Dinheiro com 3 estados | ✅ (PR anterior) |
| Job avisos dia 1 / recibos na confirmação | ✅ calendário/sweep + outbox |
| Documentos `generated_from` | ✅ (PR anterior + jobs) |
| Account Statement sob pedido | ❌ (não é critério de fecho desta fatia) |
| Enable Banking PSD2 completo (sync, consentimento real, ASPSP) | ❌ **depois** dos testes adversariais do kernel (ordem §8) |
| UI admin | ❌ |
| Portal saldo | F3 |
| Dual-write / cutover `Quota.pago` | ❌ explicitamente fora |
| Testes adversariais extra do Finance Kernel | ❌ explicitamente depois deste PR |

## Transplante Fonte (o que se reutilizou)

- Extração de pagador no descritivo SEPA/Santander e CSV multi-banco → `f2-csv-movements.ts` / `f2-identity.ts` (cópia genérica; **não** importa `identity-matrix.ts` nem `csv-bank-parser.ts`, que puxam `Quota` / PII / mapas do prédio).
- Match tenant-scoped: `constitution_fracoes` + `owner_contact_drafts` confirmados. Nome por igualdade normalizada ou tokens completos (nunca substring: ANA ≠ JOANA). Resultado = `Payment` candidato, nunca cascata Fonte.
- Canal `email` do aviso de reauth: `Person.email` do Admin/gestor activo. Sem email → placeholder `admin@invalid` e `notification_delivery.status = skipped` (o placeholder não conta como mailbox). O IBAN da conta fica no payload só como contexto, nunca como `notification_delivery.destination`.

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2
```

## API (resumo)

- `POST /api/f2/payments`
- `POST /api/f2/payments/candidates` — CSV (`csvText`) ou `movements[]`
- `POST /api/f2/payments/:id/verify-cash`
- `POST /api/f2/payments/:id/deposit-cash`
- `POST /api/f2/payments/:id/allocate` — enfileira recibo
- `POST /api/f2/payments/:id/receipt`
- `POST /api/f2/ledger/validate`
- `POST /api/f2/periods/open`
- `POST /api/f2/periods/close`
- `POST /api/f2/documents/payment-notice`
- `POST /api/f2/bank-connections` / `GET /api/f2/bank-connections`
- `POST /api/f2/jobs/reauth-notices`
- `POST /api/f2/jobs/monthly-notices`
- `POST /api/f2/jobs/receipt-sweep`
- `POST /api/f2/jobs/calendar-sweep`
