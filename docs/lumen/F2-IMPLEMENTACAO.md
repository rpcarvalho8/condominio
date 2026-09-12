# F2 — Estado de implementação (Finance Kernel + Enable Banking PSD2)

**Branch:** `cursor/f2-enable-banking-psd2`  
**Base documental:** `docs/lumen/06-FATIAS.md` §8, ADR-003, ADR-012, ADR-014, ADR-028, ADR-029, `PRODUCTION-GATES.md` Banking

## Posição face ao plano

O plano (`06-FATIAS.md`) distingue:

1. **Finance Kernel** — Obligation / Payment / Allocation / Ledger / SettlementPolicy / AccountingPeriod / cash / hash-chain  
2. **Enable Banking** — *só depois* do Finance Kernel passar testes adversariais (ordem de execução §8)  
3. **Critério de conclusão F2** — sync bancário **ou** aviso proactivo de reautorização, Payments candidatos, Allocation + hash-chain, cash 3 estados, avisos dia 1, recibos na confirmação, `generated_from`

**Este PR fecha (2):** consentimento ASPSP real, scopes, ciclo de vida, reautorização, sync → movimentos tenant-scoped + Payments candidatos. O aviso proactivo (14 dias) **coexiste** com a reauth PSD2. CSV continua o fallback. Dual-write Fonte (`Quota.pago`) fica fora.

## Fronteira dura (este slice)

- **Não substitui** o modelo Fonte `Quota.pago` / `routes/quotas` / `routes/bank.ts`. O kernel F2 coexiste; dual-write e cutover da Fonte são trabalho posterior.
- Payments candidatos **nunca** marcam `Quota.pago=true` no caminho feliz (sync PSD2 ou CSV).
- Hash-chain = deteção de adulteração (ADR-029), não imutabilidade absoluta.
- `BankConnection` liga-se à **conta do condomínio** (IBAN + ASPSP + sessão Enable Banking), não à pessoa do admin (ADR-014). Sobrevive a troca de administrador.
- UI admin = mínimo para exercitar a API (`/f2/banking`). Sem portal condómino (F3), atas/voto (F4–F6).

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| `Obligation` (origem F1) | ✅ | Reutiliza orçamento aprovado |
| `Payment` + `allocation_status` (ADR-012) | ✅ | Válido sem Allocation; ortogonal a cash |
| Cash `registered → verified → deposited` (ADR-028) | ✅ | Fiscalizacao `second_person`; `bank_deposit`/`deposited` exigem movimento tenant-scoped |
| `Allocation` → `LedgerEntry` hash-chain (ADR-029) | ✅ | Mutex por tenant + `BEGIN IMMEDIATE` |
| Aviso proactivo de reautorização | ✅ | Lead 14 dias; outbox `notify.bank_reauth`; destination = email do gestor, **nunca** IBAN; fallback `admin@invalid` + `skipped` |
| Reauth PSD2 real | ✅ | `POST /bank-connections/authorize` + `/reauthorize` + `GET /bank/callback`; scopes persistidos; sessão/account_uid na conta do condomínio |
| Sync Enable Banking → candidatos | ✅ | Créditos → `f2_bank_movements` + Payment (`candidate_source=enable_banking`); débitos só movimento; idempotente por `eb:{transaction_id}`; sem `Quota.pago` |
| Falhas observáveis | ✅ | `last_error` sanitizado (sem JWT/PEM/Bearer); 401/403 → `reauthorization_required` + fallback CSV |
| Jobs idempotentes | ✅ | Outbox `f2.bank_sync` (`f2:bank-sync:{tenant}:{connection}:{dia}`); calendário enfileira sync se sessão válida |
| CSV fallback | ✅ | `POST /payments/candidates` com `csvText`; activo quando reauth / sessão em falta / last_error de auth |
| Testes adversariais do kernel | ✅ | `test:f2-adversarial` — 8/8; AuthZ alargada às rotas PSD2 |

## Critério F2 — o que fecha aqui vs o que fica

| Item do critério / tabela F2 | Estado |
|---|---|
| Sync bancário **ou** aviso proactivo de reautorização | ✅ **ambos** — sync PSD2 + aviso 14 dias |
| Payments candidatos via reconciliação / CSV / identity-matrix / PSD2 | ✅ kernel; sem mapas Fonte hardcoded |
| Allocation + hash-chain | ✅ |
| Dinheiro com 3 estados | ✅ |
| Job avisos dia 1 / recibos na confirmação | ✅ |
| Documentos `generated_from` | ✅ |
| Account Statement sob pedido | ❌ (não é critério de fecho desta fatia) |
| Enable Banking PSD2 (consentimento, scopes, sync, last_error, fallback CSV) | ✅ |
| UI admin completa | ❌ só `/f2/banking` para exercitar a API |
| Portal saldo | F3 |
| Dual-write / cutover `Quota.pago` | ❌ explicitamente fora |

## Transplante Fonte (o que se reutilizou)

- Cliente JWT RS256 + mapping snake_case/camelCase de transacções Enable Banking → `enable-banking-adapter.ts` (adaptado de `routes/bank.ts`). **Não** escreve `bank_connections` / `bank_transactions` / `Quota.pago`.
- Extração de pagador / IBAN de contraparte: `f2-identity.ts` + `extractCounterpartyIban` (filtra o IBAN da conta do condomínio).
- Match tenant-scoped: `constitution_fracoes` + `owner_contact_drafts` confirmados. Resultado = Payment candidato, nunca cascata Fonte.

## Segredos

`ENABLE_BANKING_CLIENT_ID` / `ENABLE_BANKING_PRIVATE_KEY` nunca são persistidos nem logados. `sanitizeBankError` remove Bearer, JWT e PEM antes de `last_error` / `console.error`. A resposta HTTP de `GET /bank-connections` omite `session_id` e `auth_state`.

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2
# suite adversária isolada (já incluída em test:f2):
cd packages/web && bun run test:f2-adversarial
```

## Adversariais

Suite: `packages/web/src/api/f2.adversarial.test.ts` — `bun run test:f2-adversarial` (também corre em `test:f2`). Extende o kernel existente; não introduz modelo financeiro paralelo.

| Propriedade | Resultado | Como é demonstrado |
|---|---|---|
| Isolamento multi-tenant | PASS | Payments / ledger / bank_connections / outbox de A ≠ B; GET só devolve o IBAN do tenant |
| Concorrência allocate + ingest | PASS | Sequences únicas; 1 payment/movimento por ref |
| Cash | PASS | `registered` não liquida; self-verify proibido; deposit exige movimento do tenant |
| AuthZ gestor | PASS | Rotas kernel + authorize/reauthorize/revoke/sync/`jobs/bank-sync` → 403 para Owner / Fiscalizacao / sem membership |
| Reauth: destination nunca IBAN | PASS | Email do gestor ou `admin@invalid` + `skipped` |
| Identity + caps | PASS | ANA ⊄ JOANA; payloads grandes → 400 |
| Hash-chain | PASS | Tamper → `ledger/validate` `ok: false` |
| Idempotência outbox | PASS | Retry `notify.bank_reauth` / `f2.issue_receipt` sem duplicar |

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
- `POST /api/f2/bank-connections` / `GET /api/f2/bank-connections` — vista pública (sem `session_id`)
- `POST /api/f2/bank-connections/authorize` — inicia consentimento ASPSP (`psu_type: business`)
- `POST /api/f2/bank-connections/reauthorize` — reauth real (aviso proactivo continua a coexistir)
- `POST /api/f2/bank-connections/revoke`
- `POST /api/f2/bank-connections/sync` — movimentos + candidatos; `skipped` + `fallback: csv` quando a sessão não serve
- `GET /api/f2/bank/callback` — OAuth Enable Banking (sem membership; `state` tenant-scoped)
- `POST /api/f2/jobs/reauth-notices`
- `POST /api/f2/jobs/bank-sync` — outbox idempotente
- `POST /api/f2/jobs/monthly-notices`
- `POST /api/f2/jobs/receipt-sweep`
- `POST /api/f2/jobs/calendar-sweep` — reauth + enqueue sync se autorizado + avisos/recibos
