# F3 — Estado de implementação (Invitation Essencial)

**Branch:** `cursor/f3-invitation`  
**Base documental:** `docs/lumen/06-FATIAS.md` §F3, ADR-001, ADR-006, ADR-017, Domain Kernel F0

## Posição face ao plano

O plano distingue o núcleo de onboarding (Invitation + verificação de contacto + Membership) do resto do critério do piloto (portal saldo Ledger, PWA, spike iOS push, tickets).

**Este PR fecha o núcleo Invitation.** Portal saldo / PWA / push ficam follow-up.

## Fronteira dura (este slice)

- **Nunca** QR físico / onboarding por QR de parede (ADR-001). Sem rota `/qr`.
- **Nunca** envio automático a partir de OCR/`confirm-contactos` (ADR-017). Lote só com botão explícito ou `contactDraftIds`.
- Sem dual-write / cutover `Quota.pago`.
- Sem atas / voto / F5 / F4 ops.
- Sem trabalho novo Enable Banking.
- Sem portal PWA completo + push iOS.
- Sem OCR/PDF F1 gaps.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| Modelo `Invitation` | ✅ | Fração + contacto + `token_hash` opaco + expires + revoked + `used_at` + `lote_id` |
| API gestor | ✅ | `POST /api/f3/invitations`, `/lote`, `GET` listar, `POST :id/revoke` |
| AuthZ | ✅ | Admin / PlatformAdmin; Owner / Fiscalizacao → 403 |
| Verificação de contacto | ✅ | Código de 6 dígitos **ou** link opaco; **não é KYC** |
| Aceitar → Person + Membership | ✅ | Reutiliza `createMembership`; sessão alinhada a F0 (`GET /kernel/me`) |
| Outbox email | ✅ | `notify.invitation_created` / `notify.invitation_verify`; chave de idempotência; delivery observável |
| AuditEvent | ✅ | create / revoke / contact_verified / accept |
| Isolamento multi-tenant | ✅ | `tenant_id` em todas as escritas; listar A ≠ B |
| Token não previsível | ✅ | 32 bytes `base64url`; só hash persistido |
| Painel de ativação mínimo | ✅ | Convidados / pendentes / contas; portal+docs = follow-up (`null`) |
| UI | ✅ | `/f3/ativacao` (gestor) + `/convite/:token` (público) |

## Critério F3 — o que fecha aqui vs o que fica

| Item | Estado |
|---|---|
| Convite individual + lote + revogação + expiry | ✅ |
| Verificação de contacto antes de Membership | ✅ |
| Membership correcta na aceitação; auth F0 | ✅ |
| Multi-tenant + AuthZ + AuditEvent + outbox idempotente | ✅ |
| Painel de ativação mínimo | ✅ |
| Portal saldo Ledger | ❌ follow-up (exige F2 fiável no portal) |
| PWA + spike iOS push | ❌ follow-up |
| Tickets+foto / contactar admin no portal | ❌ já Fonte; não é este slice |

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

## API (resumo)

Gestor (Membership Admin/PlatformAdmin):

- `POST /api/f3/invitations` `{ fracaoId, contacto, canal?, personName?, roleCode? }`
- `POST /api/f3/invitations/lote` `{ items[] }` **ou** `{ contactDraftIds[] }`
- `GET  /api/f3/invitations?loteId=`
- `POST /api/f3/invitations/:id/revoke`
- `GET  /api/f3/activation`

Público (token opaco; sem Membership):

- `GET  /api/f3/public/invitations/:token`
- `POST /api/f3/public/invitations/:token/verify/request`
- `POST /api/f3/public/invitations/:token/verify/confirm` `{ code }` ou `{ verificationToken }`
- `POST /api/f3/public/invitations/:token/accept` — exige contacto já verificado
