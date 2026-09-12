# F3 — Estado de implementação (Invitation + portal saldo Ledger)

**Branch:** `cursor/f3-portal-saldo-ledger`  
**Base documental:** `docs/lumen/06-FATIAS.md` §F3, ADR-001, ADR-006, ADR-015, ADR-017, Domain Kernel F0, Finance Kernel F2

## Posição face ao plano

O plano distingue o núcleo de onboarding (Invitation + verificação de contacto + Membership) do resto do critério do piloto (portal saldo Ledger, PWA, spike iOS push, tickets).

**Este PR fecha o portal Essencial de saldo + documentos F2.** PWA / push / tickets+foto ficam follow-up.

## Fronteira dura (este slice)

- **Nunca** QR físico / onboarding por QR de parede (ADR-001). Sem rota `/qr`.
- **Nunca** envio automático a partir de OCR/`confirm-contactos` (ADR-017).
- Sem dual-write / cutover `Quota.pago`. Saldo do portal **nunca** lê `Quota.pago` nem `Obligation.openAmountCents` como fonte de verdade.
- Sem atas / voto / F5 / F4 ops.
- Sem trabalho novo Enable Banking.
- Sem portal PWA completo + push iOS.
- Sem OCR/PDF F1 gaps.
- Tickets+foto / contactar admin: já Fonte; não expandir aqui.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| Modelo `Invitation` | ✅ | Fração + contacto + `token_hash` opaco + expires + revoked + `used_at` + `lote_id` |
| API gestor | ✅ | `POST /api/f3/invitations`, `/lote`, `GET` listar, `POST :id/revoke` |
| AuthZ convites | ✅ | Admin / PlatformAdmin; Owner / Fiscalizacao → 403 |
| Verificação de contacto | ✅ | Código de 6 dígitos **ou** link opaco; **não é KYC** |
| Aceitar → Person + Membership | ✅ | Reutiliza `createMembership`; sessão alinhada a F0 (`GET /kernel/me`) |
| **Portal saldo Ledger** | ✅ | `GET /api/f3/portal/saldo` reconstrói `Σ Obligation.amountCents − Σ Ledger credits` por fração da Membership activa |
| **Documentos F2** | ✅ | Listagem + download de `PaymentNotice` / `Receipt` / `AccountStatement`; extrato sob pedido |
| AuthZ portal | ✅ | Só Membership activa **com fração**; Admin sem fração → 403; isolamento multi-tenant fail-closed |
| Painel de ativação | ✅ | `portalOpen` / `documentsSeen` = pessoas distintas com `portal.opened` / `financial_document.seen` |
| UI | ✅ | `/f3/ativacao` (gestor) + `/convite/:token` + `/f3/portal` (Sevilla) |

## Portal — saldo Ledger (estado)

O condómino autenticado com Membership activa da fração vê o saldo em aberto e as dívidas **reconstruídos do Ledger F2** (`reconstructFracaoBalance`). Não há cache de saldo, não há `Quota.pago`. `FinancialDocument` continua a ser representação (ADR-015): o download inclui `generated_from` (obligation / payment / ledger ids). O extrato (`AccountStatement`) é emitido sob pedido a partir da mesma reconstrução.

Sinais do painel `/f3/ativacao`: a primeira leitura de saldo grava `portal.opened`; o download grava `financial_document.seen`. Sem sinal, as métricas são `0` (já não `null`).

## Critério F3 — o que fecha aqui vs o que fica

| Item | Estado |
|---|---|
| Convite individual + lote + revogação + expiry | ✅ |
| Verificação de contacto antes de Membership | ✅ |
| Membership correcta na aceitação; auth F0 | ✅ |
| Multi-tenant + AuthZ + AuditEvent + outbox idempotente | ✅ |
| Painel de ativação (incl. portal/docs) | ✅ |
| Portal saldo Ledger | ✅ |
| Documentos financeiros descarregáveis e rastreáveis | ✅ |
| PWA + spike iOS push | ❌ follow-up |
| Tickets+foto / contactar admin no portal | ❌ já Fonte; não é este slice |

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

## API (resumo)

Gestor (Membership Admin/PlatformAdmin):

- `POST /api/f3/invitations` `{ fracaoId, contacto, canal?, personName?, roleCode?, expiresInMs? }` — devolve `token` **uma única vez**
- `POST /api/f3/invitations/lote` `{ items[] }` **ou** `{ contactDraftIds[] }`
- `GET  /api/f3/invitations?loteId=`
- `POST /api/f3/invitations/:id/revoke`
- `GET  /api/f3/activation` — `portalOpen` / `documentsSeen` são contagens reais (0 se ainda não houver sinal)

Portal condómino (Membership activa da fração):

- `GET  /api/f3/portal/saldo` — saldo/dívidas por fração, `source: "ledger"`; `portal.opened` só na primeira abertura
- `GET  /api/f3/portal/documents` — avisos / recibos / extratos da(s) fração(ões) da Membership
- `GET  /api/f3/portal/documents/:id/download` — HTML rastreável (`generated_from`); AuditEvent `financial_document.seen`
- `POST /api/f3/portal/documents/account-statement` `{ fracaoId? }` — extrato sob pedido; idempotente por tenant+fração+período

Público (token opaco; sem Membership):

- `GET  /api/f3/public/invitations/:token`
- `POST /api/f3/public/invitations/:token/verify/request`
- `POST /api/f3/public/invitations/:token/verify/confirm` `{ code }` ou `{ verificationToken }`
- `POST /api/f3/public/invitations/:token/accept`

Rate limit mínimo (IP + token) em verify/request, verify/confirm e accept.
