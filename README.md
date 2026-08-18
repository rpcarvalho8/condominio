# Gestão de Condomínio

Aplicação web para gestão de condomínios, com sincronização bancária automática (Enable Banking → Santander Empresas), reconciliação de quotas/despesas, recibos, relatórios e portal do condómino.

> README actualizado em 2026-08-12: foco na web app (`packages/web`), dados do edifício na BD, mobile/desktop arquivados.

---

## 1. Stack

- **Runtime**: Bun
- **Backend**: Hono (`.basePath("api")`) — código em `packages/web/src/api/`
- **Frontend**: React 19 + Vite 7 + Tailwind CSS + Wouter — código em `packages/web/src/web/`
- **Base de dados**: Turso (LibSQL/SQLite) via Drizzle ORM. Em dev local: `file:./local.db` (ou path em `DATABASE_URL`).
- **Auth**: better-auth (sessão via cookie)
- **Integração bancária**: [Enable Banking](https://enablebanking.com) — Santander Totta (Santander Empresas PT)

Monorepo Bun workspaces. Um único servidor Vite (`packages/web`) serve API (`/api/*`) e frontend (`/*`) na mesma porta (4200).

> `packages/mobile` e `packages/desktop` estão em `_archive/` (fora do foco actual). Não fazem parte do `bun run dev`.

---

## 2. Módulos implementados

| Módulo | Estado |
|--------|--------|
| Autenticação (better-auth, roles admin/condómino) | ✅ |
| Frações & Proprietários | ✅ |
| Quotas mensais + extras (elevadores, portão/motor, incêndio, obras) | ✅ |
| Recibos PDF (geração + envio automático mensal) | ✅ |
| Despesas | ✅ |
| Fornecedores | ✅ |
| Morosos (controlo de dívidas) | ✅ |
| Relatórios financeiros (mensal, automático) | ✅ |
| Portal do condómino | ✅ |
| **Sincronização bancária — Enable Banking (Santander Empresas)** | ✅ |
| Importação manual de CSV (extratos Santander) | ✅ |
| Motor de reconciliação / Matriz de Identidade (auto-match fração ↔ movimento) | ✅ |
| Camada 2 — fallback LLM (Groq/OpenRouter) para transações não identificadas | ✅ |
| Agente de monitorização de pasta (importação automática de CSV) | ✅ |

---

## 3. Variáveis de ambiente (`.env` na raiz do projeto)

```env
NODE_ENV=development
WEBSITE_URL=http://localhost:4200
# Com ngrok (Enable Banking callback HTTPS):
# WEBSITE_URL=https://xxxx.ngrok-free.dev
# Com cloudflared (gravação iPad / HTTPS):
# WEBSITE_URL=https://xxxx.trycloudflare.com

# Auth
BETTER_AUTH_SECRET=...

# Base de dados (Turso ou ficheiro local)
DATABASE_URL=libsql://... | file:./local.db
DATABASE_AUTH_TOKEN=...          # só necessário para Turso remoto

# Gateway/Pagamentos (opcional)
AI_GATEWAY_BASE_URL=
AI_GATEWAY_API_KEY=
AUTUMN_SECRET_KEY=

# LLM Fallback — Camada 2 (opcional)
GROQ_API_KEY=
OPENROUTER_API_KEY=

# ── Enable Banking ──────────────────────────────────────────────
ENABLE_BANKING_CLIENT_ID="<application_id do portal>"
ENABLE_BANKING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ENABLE_BANKING_ASPSP_NAME=Santander Totta
ENABLE_BANKING_ASPSP_COUNTRY=PT
ENABLE_BANKING_REDIRECT_URI="https://xxxx.ngrok-free.dev/api/bank/callback"
```

### Segurança de dados

- Dados pessoais de condóminos vivem na **BD** e em ficheiros locais **gitignored**: `identify-data.json`, `cartas-julho-data.json`, `bank-identity-map.json`.
- **Nunca** commitar `.pem` / private keys. `*.pem` está no `.gitignore`.
- Clone novo: restaurar os JSON locais (backup) + correr seeds abaixo.

### Detalhes críticos Enable Banking

1. **`ENABLE_BANKING_ASPSP_NAME`** = exactamente `Santander Totta`.
2. **`ENABLE_BANKING_PRIVATE_KEY`** = PKCS8 (`BEGIN PRIVATE KEY`), sem cifra; tem de corresponder ao certificado **activo** no portal (`Wrong signature` = mismatch / chave revogada).
3. **`ENABLE_BANKING_REDIRECT_URI`** = HTTPS, byte a byte igual à allowlist do portal. Em local: `ngrok http 4200` e actualizar `.env` + portal quando o subdomínio mudar.
4. Abrir a app pelo **URL do ngrok** durante o connect (não só localhost).

---

## 4. Como testar a integração bancária localmente

```bash
bun install
# Preencher .env (secção 3)

ngrok http 4200
# registar <URL>/api/bank/callback no portal + .env

bun run dev
# aceder via URL ngrok → Login → Importar Dados → Conectar Banco
```

Depois de ligado, **Importar Dados** mostra estado, **Sincronizar agora**, histórico CSV e agente de pasta.

### Backfill 89 dias (consola do browser, autenticado)

```js
fetch("/api/bank/sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    date_from: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    date_to: new Date().toISOString().slice(0, 10),
  }),
}).then(r => r.json()).then(console.log);
```

---

## 5. Arquitectura bancária (`packages/web/src/api/routes/bank.ts`)

```
GET    /api/bank/status
GET    /api/bank/connect
GET    /api/bank/callback
POST   /api/bank/sync
DELETE /api/bank/disconnect
POST   /api/bank/process-staged
GET    /api/bank/synclogs
```

Fluxo: JWT RS256 (`kid` = CLIENT_ID) → sessão Enable Banking → polling (cron + sync no arranque). Motor: staging → Matriz de Identidade → regex legacy → LLM → revisão manual.

---

## 6. Seeds e BD

```bash
cd packages/web
bun run db:push
bun run seed:fracoes          # matriz → tabela fracoes
bun run seed:gdpr-config      # configs/cartas sem PII no código
bun run seed:ancora
bun run seed:quotas-extras    # quotas obras/extras
bun --env-file=../../.env run scripts/create-admin.ts
```

Na raiz:

```bash
bun run smoke:db              # smoke check (contagens/chaves, sem PII)
```

Checklist manual: [`docs/checklist-smoke-local.md`](docs/checklist-smoke-local.md).

## 7. Dev

```bash
bun install
bun run dev                   # API + frontend, porta 4200
```

`bun install` instala também o Chromium do Puppeteer (útil para testes automatizados; **não** é necessário para gravar no iPad).

## 8. Testar gravação de reunião no iPad (Safari)

Cenário: o portátil fica em casa no Wi-Fi; só o iPad vai para a reunião (hotspot/4G). A gravação de microfone no Safari iOS **exige HTTPS**.

O mesmo `WEBSITE_URL` HTTPS da secção 4 (ngrok) serve. Em alternativa, sem conta: **cloudflared**.

### Passos (cloudflared)

1. Em casa, terminal 1 (raiz do repositório):

```bash
bun run dev
```

2. Terminal 2:

```bash
cloudflared tunnel --url http://localhost:4200
# se não estiver no PATH: /home/rui/bin/cloudflared tunnel --url http://localhost:4200
```

Copiar o URL `https://….trycloudflare.com`.

3. Definir `WEBSITE_URL` no `.env` com esse URL HTTPS e **reiniciar** `bun run dev`.

4. No Safari do iPad, abrir o mesmo URL HTTPS. Login → **Atas** ou **Reuniões** → **Gravar áudio** → autorizar o microfone.

### Notas

- O URL do túnel muda a cada sessão → actualizar `WEBSITE_URL` e reiniciar o `bun run dev`.
- O portátil tem de permanecer acordado; se dormir ou o túnel cair, o iPad deixa de funcionar.
- Sem túnel: HTTP na LAN permite navegar, mas o microfone falha; em alternativa, gravar um memo de voz e carregar o ficheiro.

## 9. Próximos passos

- [x] Migrar frações/âncoras para BD; limpar PII do código tracked
- [x] Remover `.pem` do tip (+ purge histórico; force-push coordenado se ainda pendente)
- [x] Arquivar mobile/desktop; README + smoke checklist
- [ ] Domínio/subdomínio fixo HTTPS (em vez de ngrok efémero)
- [ ] Partir `dashboard.ts` / multi-tenancy / wizard onboarding
- [ ] Railway — só após core estável + multi-tenancy + beta externo
