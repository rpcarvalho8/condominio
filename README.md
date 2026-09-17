# Gestão de Condomínio (LUMEN)

Aplicação web de gestão de condomínios em propriedade horizontal (Portugal). Um único processo **Vite + Hono** (`packages/web`) serve o frontend e a API em `/api/*` na porta **4200**.

Há **duas camadas no mesmo binário**, ainda sem cutover:

| Camada | O que é | UI |
|--------|---------|-----|
| **Fonte** | Operação do piloto Urbanização da Fonte (`Quota.pago`, `user.role`, rotas `/api/quotas`, `/api/bank`, …) | Dashboard, quotas, morosos, `/portal` |
| **LUMEN F0–F3** | Domain Kernel no mesmo processo: TenantDirectory, ingestão, Ledger, convites, portal Essencial | `/f1`, `/f2/banking`, `/f3/ativacao`, `/f3/portal` |

O produto-alvo está especificado em [`docs/lumen/`](docs/lumen/00-INDICE.md) (v6.1). **Dinheiro, votos e efeitos legais em produção real permanecem NO-GO** até aos [production gates](docs/lumen/PRODUCTION-GATES.md). O kernel F2 **não** dual-write para `Quota.pago`.

> Actualizado em 2026-09-17 a partir de `produto` @ `0f8f7ea` (incl. Astra A2). `packages/mobile` e `packages/desktop` estão em `_archive/` e não entram no `bun run dev`.

---

## Visão geral

**Stack:** Bun 1.3 · React 19 · Vite 7 · Hono 4 · Tailwind 4 · Wouter · Drizzle ORM · Turso/LibSQL · better-auth · Enable Banking (PSD2).

**O que o código faz hoje**

- Auth por sessão (better-auth). Área admin Fonte: `user.role === "admin"`. Caminhos LUMEN (`/api/kernel`, `/api/f1`–`/f3`, `/api/platform`): **Membership** activa (`Admin` / `PlatformAdmin` para gestão).
- Fonte: frações, quotas, recibos PDF, despesas, fornecedores, morosos, relatórios, importação CSV, sync bancário Enable Banking, inbox Gmail, atas/reuniões (incl. `RecordingSegment`), tickets admin.
- **F0** — Person, Membership, AuditEvent, Outbox, TenantDirectory (1 BD por tenant no provisionamento). `tenant_id` **canónico** (Astra A2): `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, sem `..`; recusado na criação; storage local/S3 **não** sanitiza para `_` (isso colidia `a/b` com `a_b`).
- **F1** — Upload CSV/Excel/texto/PDF/foto (máx. 10 MB) → extracção → confirmação linha a linha (Σ permilagens = 1000‰) → orçamento + obligations. Object storage: local por omissão; S3-compatible via env (fail-closed).
- **F2** — Obligation / Payment / Allocation / Ledger (hash-chain), cash em 3 estados, Payments candidatos, Enable Banking na **conta do condomínio** (não na pessoa do admin). Coexiste com a Fonte; candidatos **não** marcam `Quota.pago`.
- **F3** — Convite + verificação de contacto + Membership; portal com saldo **Ledger** (nunca `Quota.pago`); documentos F2; ticket+foto; contactar admin; PWA (service worker **não** cacheia `/api`). Spike iOS push: **FRAGILE**. Sem onboarding por QR.

---

## Pré-requisitos

| Ferramenta | Versão | Notas |
|------------|--------|--------|
| [Bun](https://bun.sh) | **1.3.5** (`packageManager` na raiz) | Runtime e instalador. `curl -fsSL https://bun.sh/install \| bash` |
| Git | qualquer | |
| Node.js | ≥ 20 (opcional) | Só se precisares de ferramentas Node à parte; o `dev` corre em Bun |
| Docker Compose | opcional | Só para MinIO local (`docker-compose.minio.yml`) |
| ngrok ou [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) | opcional | HTTPS para Enable Banking callback e microfone Safari iOS |

`bun install` descarrega Chromium do Puppeteer (~170–300 MB) para PDFs. Em CI podes definir `PUPPETEER_SKIP_DOWNLOAD=1` (não uses isto em máquinas de desenvolvimento que geram recibos).

---

## Configuração do ambiente

Ficheiro **`.env` na raiz do repositório** (Vite carrega-o a partir daí). Nunca commitar.

```bash
cp .env.template .env
```

Gera o secret de auth:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Obrigatórias para arrancar

| Variável | Exemplo | Função |
|----------|---------|--------|
| `NODE_ENV` | `development` | |
| `WEBSITE_URL` | `http://localhost:4200` | URL pública da app (HTTPS em túnel) |
| `BETTER_AUTH_SECRET` | 32+ bytes hex | Sessões better-auth |
| `DATABASE_URL` | `file:./local.db` ou `libsql://…` | BD do tenant Fonte (processo actual) |
| `DATABASE_AUTH_TOKEN` | (Turso) | Só remoto |

### LUMEN / plataforma (defaults seguros)

| Variável | Default | Função |
|----------|---------|--------|
| `PLATFORM_DATABASE_URL` | `file:./platform.db` | TenantDirectory (fora da BD de tenant) |
| `PLATFORM_DATABASE_AUTH_TOKEN` | — | Turso da plataforma, se remoto |
| `TENANT_DB_ROOT` | `./data/tenants` | Ficheiros `.db` no provisionamento local |
| `TENANT_ID` | NIF em `condominio.ts` | Carimbo kernel neste processo (não vem do cliente) |
| `PLATFORM_ENFORCE_DIRECTORY` | off | `1` = rotas kernel exigem tenant activo no directory |
| `CONTENT_BLOB_ROOT` | `packages/web/data/content` | Blobs F1 em disco |
| `OBJECT_STORAGE_DRIVER` | `local` | `s3` / `s3-compatible` para staging |

**`tenant_id` válido:** começa por alfanumérico, depois `[A-Za-z0-9._-]`, máx. 64, sem `..`. `POST /api/platform/tenants` recusa o resto (`invalid_tenant_id`).

### Object storage S3 (opcional)

Com `OBJECT_STORAGE_DRIVER=s3` são obrigatórios `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Sem credenciais o driver **falha no uso** (não faz fallback silencioso para disco). Ver [F1-IMPLEMENTACAO.md](docs/lumen/F1-IMPLEMENTACAO.md). MinIO só-dev:

```bash
docker compose -f docker-compose.minio.yml up -d
./scripts/dev-minio-smoke.sh
```

### Integrações opcionais

O código lê estas variáveis; **Enable Banking não está no `.env.template`** — acrescenta-as à mão se fores testar banco:

```env
# Enable Banking (Fonte /api/bank e kernel /api/f2)
ENABLE_BANKING_CLIENT_ID=
ENABLE_BANKING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ENABLE_BANKING_ASPSP_NAME=Santander Totta
ENABLE_BANKING_ASPSP_COUNTRY=PT
ENABLE_BANKING_REDIRECT_URI=https://xxxx.ngrok-free.dev/api/bank/callback
# Kernel F2 (omisso: http://localhost:4200/api/f2/bank/callback)
# ENABLE_BANKING_F2_REDIRECT_URI=https://xxxx.ngrok-free.dev/api/f2/bank/callback

GROQ_API_KEY=
OPENROUTER_API_KEY=
F1_OCR_ENDPOINT=
F1_OCR_API_KEY=
GMAIL_USER=
GMAIL_APP_PASSWORD=
ADMIN_NOTIFY_EMAIL=
```

- Chave PKCS8 (`BEGIN PRIVATE KEY`) tem de bater com o certificado **activo** no portal Enable Banking.
- `ENABLE_BANKING_REDIRECT_URI` HTTPS, byte a byte igual à allowlist. Abrir a app pelo URL do túnel durante o connect.
- Inbox Gmail: desligada se `GMAIL_APP_PASSWORD` estiver vazio.

PII de condóminos vive na BD e em JSON **gitignored** (`identify-data.json`, `cartas-julho-data.json`, `bank-identity-map.json`). Nunca commitar `.pem`.

---

## Instalação e execução

```bash
git clone <url> condominio
cd condominio
cp .env.template .env          # preencher secção acima
bun install
```

**Desenvolvimento** (API + React, um processo):

```bash
bun run dev
# → http://localhost:4200
```

Primeiro admin na BD configurada em `DATABASE_URL`:

```bash
cd packages/web
bun --env-file=../../.env run scripts/create-admin.ts
# default: admin@condominio.local / admin123
```

Clone Fonte com dados: `bun run db:push` e, se a BD estiver vazia, os seeds em `packages/web` (`seed:fracoes`, `seed:gdpr-config`, `seed:ancora`, …). Smoke sem PII: `bun run smoke:db` na raiz.

**Build / typecheck** (raiz):

```bash
bun run typecheck
bun run build
```

Preview do bundle: `cd packages/web && bun run preview`.

---

## Guia de utilização

Login em `/login`. Condómino Fonte: `/portal`. Admin Fonte: sidebar (visão geral, frações, quotas, …).

### LUMEN nesta versão

| Rota | Quem | O que testar |
|------|------|----------------|
| `/f1` | Admin | Ingestão: upload → extract → editar linhas (excerto visível) → confirmar frações/contactos → orçamento. Contactos **não** disparam convites. |
| `/f2/banking` | Admin | Consentimento PSD2 na conta do condomínio (`accountIban`), sync → Payments **candidatos**, CSV fallback. Sem `Quota.pago`. |
| `/f3/ativacao` | Admin | Criar convite / lote a partir de contactos confirmados. |
| `/convite/:token` | Público | Verificar contacto + aceitar (Membership). Sem QR. |
| `/f3/portal` | Condómino com Membership + `fracao_id` | Saldo Ledger, documentos F2, ticket+foto, contactar admin. Não é `/portal`. |
| `POST /api/platform/tenants` | Membership Admin/PlatformAdmin | Provisionar tenant. Ids tipo `a/b` → 400. |

Kernel: `GET /api/kernel/me` devolve `tenantId`, `person`, `memberships`. Sem Membership → 403 nas rotas LUMEN.

Checklist Fonte (saldos CC, morosos, banco): [`docs/checklist-smoke-local.md`](docs/checklist-smoke-local.md).

### HTTPS no iPad (gravação de reunião)

O microfone no Safari iOS exige HTTPS. Com `bun run dev` a correr:

```bash
./scripts/dev-ipad.sh
# ou: cloudflared tunnel --url http://localhost:4200
```

Copia o `https://….trycloudflare.com` → `WEBSITE_URL` no `.env` → **reinicia** `bun run dev`. No iPad, o mesmo URL → Reuniões → gravar áudio.

Para Enable Banking, o mesmo túnel: actualiza `ENABLE_BANKING_REDIRECT_URI` no `.env` **e** no portal.

---

## Scripts disponíveis

Na **raiz**:

| Comando | Função |
|---------|--------|
| `bun run dev` | Vite + Hono, porta 4200 (`packages/web`, `.env` da raiz) |
| `bun run build` | Turbo: `tsc --noEmit` + `vite build` |
| `bun run typecheck` | Turbo typecheck |
| `bun run smoke:db` | Contagens/chaves da BD Fonte, sem PII |
| `bun run db:push` / `db:migrate` / `db:studio` | Drizzle (via Turbo → `packages/web`) |
| `bun run cron:local` | Runner de cron local |

Em **`packages/web`**:

| Comando | Função |
|---------|--------|
| `bun run test:f0` | Kernel + TenantDirectory + propriedades F0 |
| `bun run test:f1` | Ingestão, blobs, object storage, **tenant_id injectivo** |
| `bun run test:f2` | Finance Kernel + adversariais + adapter PSD2 |
| `bun run test:f2-adversarial` | Só adversariais F2 |
| `bun run test:f3` | Invitation, portal Ledger, tickets, PWA |
| `bun run test:kernel` / `test:platform` / `test:reuniao` | Subconjuntos |
| `bun run db:migrate:kernel` | Schema Domain Kernel na BD actual |
| `bun run db:migrate:platform` | TenantDirectory (+ tenant de teste se `PROVISION_TEST_TENANT=1`) |
| `bun run db:migrate:all-tenants` | Migrations em todos os tenants do directory |
| `bun run db:backup-tenant` | Backup/restore file-backed de um tenant |
| `bun run db:setup-local` | Setup BD local |
| `bun run lint` | ESLint |

Suite de regressão LUMEN F1–F3:

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

---

## Documentação

| Documento | Conteúdo |
|-----------|----------|
| [`docs/lumen/00-INDICE.md`](docs/lumen/00-INDICE.md) | Precedência, GO/NO-GO, mapa LUMEN v6.1 |
| [`docs/lumen/F1-IMPLEMENTACAO.md`](docs/lumen/F1-IMPLEMENTACAO.md) | F1 + S3 + MinIO + namespace de tenant |
| [`docs/lumen/F2-IMPLEMENTACAO.md`](docs/lumen/F2-IMPLEMENTACAO.md) | Finance Kernel + PSD2 (limites vs Fonte) |
| [`docs/lumen/F3-IMPLEMENTACAO.md`](docs/lumen/F3-IMPLEMENTACAO.md) | Convites, portal Ledger, PWA, tickets |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Arquitectura Fonte (pode estar atrás do kernel) |
| [`SETUP.md`](SETUP.md) | Notas VSCode; as variáveis canónicas estão no `.env.template` |

---

## Limites (código actual)

- Runtime **um processo ↔ uma BD Fonte**. TenantDirectory provisiona outros ficheiros; o servidor em `dev` continua ligado a `DATABASE_URL`.
- F4–F6 LUMEN (Authority, assembleia/voto kernel, Orquestra) **não** estão neste recorte; atas/voto/tickets LLM na Fonte são órgãos do piloto, não o kernel.
- Object storage: port `put` / `get` / `exists` apenas. Sem migração `data/content` → bucket.
- PWA: sem servidor de push (VAPID/APNs).
