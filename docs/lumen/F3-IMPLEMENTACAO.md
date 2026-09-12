# F3 — Estado de implementação (Invitation + portal Ledger + PWA)

**Branch:** `cursor/f3-pwa-essencial-ios-push`  
**Base documental:** `docs/lumen/06-FATIAS.md` §F3, `04-PORTAS.md` (Sevilla), ADR-001, ADR-006, ADR-015, ADR-017, ADR-035

## Posição face ao plano

O piloto Essencial fecha Invitation + verificação de contacto + Membership + portal saldo Ledger + documentos F2 + **PWA (service worker, offline shell, install prompt)** + **spike iOS push**.

**Este PR fecha o critério PWA Essencial e o spike iOS push.** Invitation (#15) e portal saldo/documentos (#16) já estão em `produto`. Tickets+foto / contactar admin continuam Fonte — não se expandem aqui.

## Fronteira dura (este slice)

- **Nunca** QR físico / onboarding por QR de parede (ADR-001). Sem rota `/qr`.
- **Nunca** envio automático a partir de OCR/`confirm-contactos` (ADR-017).
- Sem dual-write / cutover `Quota.pago`. Saldo do portal **nunca** lê `Quota.pago` nem `Obligation.openAmountCents` como fonte de verdade. **Sem sync offline do Ledger.**
- Sem atas / voto / F5 / F4 ops.
- Sem trabalho novo Enable Banking.
- Sem OCR/PDF F1 gaps.
- Tickets+foto / contactar admin: já Fonte; não expandir aqui.
- Sem servidor de push (VAPID / APNs) — o spike valida capacidade, não liga um canal de produção.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| Modelo `Invitation` | ✅ | Já em `produto` (#15) |
| Portal saldo Ledger + documentos F2 | ✅ | Já em `produto` (#16); UI `/f3/portal` |
| **Manifest PWA** | ✅ | `public/manifest.webmanifest` — `display: standalone`, `start_url: /f3/portal`, tema Sevilla `#D0021B` / fundo `#F5F5F7` |
| **Service worker** | ✅ | `public/sw.js` — shell mínima, `skipWaiting` + `clients.claim`, **nunca cacheia `/api`** |
| **Offline shell** | ✅ | `/offline.html` + fallback de navegação para `index.html`; `/f3/portal` mostra shell Sevilla sem inventar saldo |
| **Install prompt** | ✅ | Chromium: `beforeinstallprompt`. iOS: instrução Partilhar → «Adicionar ao ecrã principal» |
| **Spike iOS push** | ✅ FRAGILE | Ver secção abaixo. Email continua primário; push best-effort |

## PWA — comportamento

- Registo em `registerLumenServiceWorker()` (`/sw.js`, scope `/`).
- Navegação: network-first; se a rede falhar, `index.html` em cache (SPA) ou `/offline.html`.
- Assets same-origin: network-first com fallback à cache (primeira visita online precacheia a shell).
- Pedidos `/api/*` passam sempre à rede — o Ledger não é SoT offline. A shell **não** mostra `0,00 €` sem rede (isso seria uma mentira de saldo).
- `/f3/portal` deixa de passar por `ProtectedRoute` (redirect imediato para `/login`) para a shell offline poder renderizar sem sessão. A detecção de rede sonda `/sw.js` (o SW não o intercepta) e trata qualquer resposta HTTP como online — só falha de rede mostra a shell.

## Spike iOS push — resultado

| | |
|---|---|
| **Resultado** | **FRAGILE** |
| Alvo | iOS Safari 16.4+ com «Adicionar ao ecrã principal» |
| Método | Spike de capacidade (código + restrições publicadas pela Apple). Sem dispositivo iOS neste ambiente de CI/agente. |
| Decisão de canal | Email continua **primário** (envio / retry / observabilidade desde F0). Push é **best-effort**, nunca único canal para aviso crítico. |

### Evidência do spike

1. **Apple (User Notifications):** Web Push existe para Home Screen web apps em **iOS 16.4+** e para páginas no Safari de macOS. Safari **não** suporta push invisível — o service worker tem de chamar `showNotification` no evento `push` ou a permissão é revogada.
2. **Instalação obrigatória:** no iOS, `PushManager` / pedido de permissão só na PWA aberta a partir do ecrã principal (`display: standalone`). Uma tab Safari **não** conta. Não existe `beforeinstallprompt` — o condómino tem de usar Partilhar → Adicionar ao ecrã principal.
3. **Fragilidades conhecidas (2024–2026):** primeiro lançamento sem `clients.claim` falha a subscrição em silêncio; `pushsubscriptionchange` não é fiável; subscrições 404/410 têm de ser podadas no servidor (que **não** implementámos); permissão só com gesto do utilizador; Chrome iOS é WebKit — não substitui o Safari.
4. **Classificador no produto:** `classifyIosPush` em `src/web/lib/pwa.ts`.
   - iOS **&lt; 16.4** → `FAIL`
   - iOS **16.4+** (tab ou standalone, com ou sem APIs) → `FRAGILE` (produto)
   - Chromium/Android com Push API → `PASS` de capacidade, **fora** do spike iOS
5. **O que o código faz:** o SW escuta `push` e mostra notificação visível; `notificationclick` abre `/f3/portal`. **Não** há VAPID, persistência de `PushSubscription`, nem job de envio. Ligar um servidor de push fica para um slice futuro, só se o piloto o justificar — e mesmo aí o email permanece primário.

O portal mostra a classificação no rodapé (`IosPushSpikeNote`) para um teste manual em iPhone real: instalar → abrir do ecrã principal → ler o veredicto.

## Critério F3 — o que fecha aqui vs o que fica

| Item | Estado |
|---|---|
| Convite individual + lote + revogação + expiry | ✅ (#15) |
| Verificação de contacto antes de Membership | ✅ (#15) |
| Membership correcta na aceitação; auth F0 | ✅ (#15) |
| Multi-tenant + AuthZ + AuditEvent + outbox idempotente | ✅ (#15) |
| Painel de ativação (incl. portal/docs) | ✅ (#16) |
| Portal saldo Ledger | ✅ (#16) |
| Documentos financeiros descarregáveis e rastreáveis | ✅ (#16) |
| PWA + spike iOS push | ✅ este slice (push = FRAGILE) |
| Tickets+foto / contactar admin no portal | ❌ já Fonte; não é este slice |

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

PWA local (Chromium): `bun run preview` → DevTools → Application → Manifest + Service Workers; Network → Offline → `/f3/portal` deve servir a shell.

iOS (manual, dispositivo real): Safari → Partilhar → Adicionar ao ecrã principal → abrir o ícone → confirmar standalone e a nota do spike.

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
