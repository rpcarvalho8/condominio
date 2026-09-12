# F3 — Estado de implementação (Invitation + portal Ledger + PWA + tickets+foto + contactar admin)

**Branch:** `cursor/f3-tickets-foto-contactar-admin`  
**Base documental:** `docs/lumen/06-FATIAS.md` §F3, `04-PORTAS.md` (Sevilla), ADR-001, ADR-006, ADR-015, ADR-017, ADR-035

## Posição face ao plano

O piloto Essencial fecha Invitation + verificação de contacto + Membership + portal saldo Ledger + documentos F2 + PWA + spike iOS push + **ticket+foto** + **contactar admin**.

**Este PR fecha o último gap Essencial do portal condómino:** criar ticket com foto e contactar a administração em `/f3/portal`. Invitation (#15), portal saldo/documentos (#16) e PWA/spike iOS (#17) já estão em `produto`.

## Fronteira dura (este slice)

- **Nunca** QR físico / onboarding por QR de parede (ADR-001). Sem rota `/qr`.
- **Nunca** envio automático a partir de OCR/`confirm-contactos` (ADR-017).
- Sem dual-write / cutover `Quota.pago`. Saldo do portal **nunca** lê `Quota.pago` nem `Obligation.openAmountCents` como fonte de verdade. **Sem sync offline do Ledger.**
- Sem atas / voto / F5 / F4 ops “nice” (orçamentos, cotações, AuthorityRule, triagem LLM).
- Sem trabalho novo Enable Banking.
- Sem OCR/PDF F1 gaps.
- Sem servidor de push (VAPID / APNs) — o spike iOS permanece **FRAGILE**.
- Sem inventar CRM. Kit assembleia fora deste slice.
- Service worker continua a **nunca cachear `/api`**.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| Modelo `Invitation` | ✅ | Já em `produto` (#15) |
| Portal saldo Ledger + documentos F2 | ✅ | Já em `produto` (#16); UI `/f3/portal` |
| Manifest PWA + SW + offline shell + install | ✅ | Já em `produto` (#17) |
| Spike iOS push | ✅ FRAGILE | Sem VAPID/APNs; email primário |
| **Ticket + foto (portal)** | ✅ | Este slice — Membership + blob F1 + AuditEvent + outbox |
| **Contactar admin** | ✅ | Este slice — mensagem → outbox/email + estado observável |

## Tickets + foto — comportamento

Transplante do fluxo Fonte (`titulo` / `descricao` / `categoria` / `urgencia` / `status` + anexos), **não** da rota `/api/tickets` (single-tenant, `user.fracaoId`, triagem LLM, `data/tickets`).

- Persistência em `portal_tickets` + `portal_ticket_photos` (kernel, `tenant_id`).
- AuthZ: só Membership **activa** com `fracao_id`. Admin sem fração, Membership revogada, outro tenant ou outra fração → fail-closed (401/403/404).
- Foto: JPEG/PNG/WebP/GIF, máx. 5, 8MB. Bytes no **content-blob-store F1** (sha256 / tenant); metadados em `content_uploads`. Sem vídeo neste slice. `Content-Length` acima de 5×8MB (+ overhead) é rejeitado **antes** de `parseBody` (413); `file.size` é validado antes de `arrayBuffer`. Download da foto envia `X-Content-Type-Options: nosniff`.
- Sem categorização LLM (F4). Categoria/urgência aceites se válidas; default `outro` / `normal`.
- Outbox `notify.ticket_created` idempotente (`notify:ticket:{id}:created`) → email aos Admin/PlatformAdmin (mesmo resolvedor que F2) + `notification_deliveries` + AuditEvent.

## Contactar admin — comportamento

Canal mínimo, **não CRM**:

- `POST /api/f3/portal/contact-admin` `{ subject, body, fracaoId? }`
- Registo em `portal_admin_contacts` + AuditEvent `admin_contact.created`
- Outbox `notify.admin_contact` idempotente (`notify:admin_contact:{id}:created`); após complete o `body` no payload é `[REDACTED]` (espelho invitation)
- Estado observável: `queued` → `attempted` (há mailbox de admin) ou `skipped` (sem email de gestor; fallback `admin@invalid` nunca é tratado como entrega); UPDATE de status inclui `tenant_id`
- Condómino lista as suas mensagens e o estado no portal

## Critério F3 — o que fecha aqui vs o que fica

| Item | Estado |
|---|---|
| Convite individual + lote + revogação + expiry | ✅ (#15) |
| Verificação de contacto antes de Membership | ✅ (#15) |
| Membership correcta na aceitação; auth F0 | ✅ (#15) |
| Painel de ativação (incl. portal/docs) | ✅ (#16) |
| Portal saldo Ledger | ✅ (#16) |
| Documentos financeiros descarregáveis e rastreáveis | ✅ (#16) |
| PWA + spike iOS push | ✅ (#17; push = FRAGILE) |
| Tickets+foto no portal | ✅ este slice |
| Contactar admin no portal | ✅ este slice |
| Triagem LLM / prioridade heurística F4 | ❌ F4 |
| Mensagens de follow-up no ticket (thread admin↔condómino) | ❌ fica Fonte / F4 |
| Kit assembleia / atas / voto | ❌ F5 + fora de scope |
| Servidor push VAPID/APNs | ❌ não neste slice |

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

Portal local: Membership Owner activa → `/f3/portal` → criar pedido com foto → listar → contactar administração e ver estado.

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
- `GET  /api/f3/portal/tickets` — tickets da(s) fração(ões) da Membership
- `POST /api/f3/portal/tickets` — multipart (`titulo`, `descricao`, `file`/`files`) ou JSON; foto no blob F1; rate-limit autenticado (IP + user/membership + action) → 429
- `GET  /api/f3/portal/tickets/:id`
- `GET  /api/f3/portal/tickets/:id/photos/:photoId`
- `GET  /api/f3/portal/contact-admin` — mensagens do actor + estado
- `POST /api/f3/portal/contact-admin` `{ subject, body, fracaoId? }` — rate-limit autenticado → 429

Público (token opaco; sem Membership):

- `GET  /api/f3/public/invitations/:token`
- `POST /api/f3/public/invitations/:token/verify/request`
- `POST /api/f3/public/invitations/:token/verify/confirm` `{ code }` ou `{ verificationToken }`
- `POST /api/f3/public/invitations/:token/accept`

Rate limit mínimo (IP + token) em verify/request, verify/confirm e accept.

Portal autenticado: rate limit (IP + user/membership + action) em `POST /portal/tickets` e `POST /portal/contact-admin` — mesma janela/máximo que o público (20/min).
