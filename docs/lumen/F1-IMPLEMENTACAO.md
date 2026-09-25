# F1 — Estado de implementação

**Branch:** `produto` (MinIO local via #21; tip pós-merge)  
**Base documental:** `docs/lumen/06-FATIAS.md` (F1 — Ingestão + Constituição), [ADR-043](ADR-LOG.md), [ADR-044](ADR-LOG.md)

## Pipeline de unidades / permilagem (ADR-043)

F1 não fecha quando um parser aceita mais formatos. A cascata do **PR #31** — tabela delimitada → padrões regex → Groq JSON → revisão humana — melhora a tolerância de formato e usa o LLM como fallback. Isso **não** é o sistema de ingestão F1: não pergunta primeiro que informação existe no documento, não separa extracção, interpretação, validação e confirmação, e trata um score de modelo como se fosse confiança. **Não fundir o #31. Não acrescentar regex de formato. Não há arquitectura de agentes.**

O pipeline aceite é:

`Document Intake → Structure Discovery → Semantic Extraction → Canonicalization → Deterministic Validation → Human Review` (só na ambiguidade real).

Contrato e estados (`pending_review` vs `needs_human_review`): ADR-043. Dez documentos diferentes que caem no mesmo modelo canónico: [F1-INGEST-EXEMPLOS](F1-INGEST-EXEMPLOS.md).

## Perfis (ADR-044) — Fase B

O pipeline é um só. O perfil em execução é `unit_share` (frações / permilagem), e só para `kind=regulamento`. Contratos partilhados: `DocumentObservation`, `FieldEvidence`, `SystemCheck`, `ReviewState`, `IngestPipelineSummary`. O KPI continua a ser quantas decisões humanas restam.

`budget_plan` existe como contrato e no [corpus](F1-INGEST-CORPUS.md). Não há extract nem confirm. `kind=orcamento` não entra no pipeline semântico. `createAnnualBudget` e `approveBudgetAndCreateObligations` mantêm a semântica actual: orçamento previsto em draft, e `Obligation` só na aprovação, com frações já confirmadas. Orçamento previsto ≠ `Obligation` ≠ `Payment` ≠ dívida/saldo ≠ `Allocation`. O mapa de dívidas do corpus é falso positivo de `budget_plan`.

Não fundir o #31. Não implementar Orçamento neste slice. Não tocar: F2 (`Payment`, `Allocation`, `Ledger`, `SettlementPolicy`, `Quota.pago`), F4–F6, Orquestra/agentes, `FinancialTransaction`, Authority, Event Bus.

Ligação mínima já no fluxo existente: `POST /api/f1/documents/:id/extract-from-file` para `regulamento` corre o pipeline e devolve `StructuredExtraction` com `sourceExcerpt`. A UI `/f1` mostra a evidência, a confiança do sistema e quantas decisões humanas faltam. Upload e extracção não criam `Fracao` nem `Obligation`. Linhas `needs_human_review` bloqueiam a confirmação do lote. `F1_LLM_EXTRACT` omisso ou `0` no CI; Groq só se a variável for `1` e houver chave — e mesmo assim a hipótese não confirma valores.

A métrica visível na revisão é quantas linhas estão prontas com evidência e quantas decisões humanas ainda faltam. Pronta ≠ confirmada.

F1 pleno (OCR/PDF/foto + port `put/get/exists` + UI admin) está em `produto` via #19. O driver S3-compatible (env, fail-closed) entrou via #20. **Este slice é só validação técnica local com MinIO.** Não declara staging/prod ready. Não expande o produto.

## Critério do plano

> admin sobe PDF/Excel/foto, confirma **linha a linha** (excerto de origem visível), frações existem com `Obligation`s calculadas.

## O que este slice fecha

| Capacidade | Estado | Notas |
|---|---|---|
| Upload real de ficheiro (bytes) | ✅ | `POST /api/f1/documents/upload` + object storage port; max **10MB**; Content-Length early |
| MIME CSV/Excel/texto **e** PDF/foto | ✅ | jpeg/png/webp/gif + application/pdf; executáveis rejeitados |
| `content_uploads` + `ingest_documents` | ✅ | Upload ≠ confirmação |
| Extracção CSV/Excel → `extract_lines` | ✅ | Determinística; `sourceExcerpt` = linha de origem |
| Extracção texto com padrões ‰ | ✅ | Heurística |
| Extrator OCR/LLM de PDF/foto | ✅ | Mesmo contrato `StructuredExtraction`; stub determinístico em CI; `F1_OCR_ENDPOINT` opcional |
| HUMAN REVIEW se extracção fraca | ✅ | Nunca auto-confirma; nunca envia convites (ADR-017) |
| Object storage adapter | ✅ | Port `put/get/exists` inalterado; local default; S3-compatible **wired** via env |
| S3 staging/prod | ✅ | `OBJECT_STORAGE_DRIVER=s3` + `S3_*`; Bun `S3Client`; fail-closed sem credenciais |
| Confirmação linha a linha de frações | ✅ | Σ permilagem_centesimas = 100000 |
| Contactos (draft + confirmação) | ✅ | Sem convites |
| Comprovativo IBAN | ✅ | `retention_class = personal_document` |
| Orçamento anual + FCR ≥10% → obligations | ✅ | Rateio por permilagem |
| Rotas `/api/f1/*` | ✅ | Membership + manager (Admin/PlatformAdmin) fail-closed + AuditEvent |
| UI admin de revisão | ✅ | `/f1` — listar, excerto visível, editar, confirmar |

## Ainda fora / não é deste slice

- Provider OCR pago em CI (opcional via `F1_OCR_ENDPOINT` + `F1_OCR_API_KEY`)
- Convites (F3) — confirmação de contactos **não** envia (ADR-017)
- Auto-confirmação a partir de OCR — **proibido**
- Migração massiva de blobs locais já existentes (`data/content` → bucket)
- UI nova, Enable Banking novo, F2/F3 feature work

## Limitações conhecidas — `unit_share` / extracção semântica

Estado do hardening `skipProseLine` / PDF textual: **F1/unit_share hardening — fechado com limite conhecido documentado** (não «F1 resolvida»).

### `selectCodigo` com texto entre parênteses antes do código

| Campo | Conteúdo |
|---|---|
| **Limitação** | `selectCodigo` (em `roles.ts`) pode seleccionar um código incorrecto quando a linha contém texto entre parênteses **antes** do identificador real de fracção. Exemplo sintético: `BT (British Telecom) A — 600‰` → selecciona `BT` em vez de `A`. |
| **Estado** | Não corrigido. Não bloqueante para o caminho Fonte / regressão actual. |
| **Evidência** | Teste sintético em `packages/web/src/api/application/constitution/ingest/pdf-marker-skip.test.ts` (caso «BT (British Telecom)…») — documenta o comportamento actual (`BT` + `B`) sem o esconder. |
| **Âmbito real** | Não observado no documento Fonte (Anexo Regulamento): 33/33 códigos correctos na regressão. Risco desconhecido para documentos futuros ainda não testados — **não** generalizar. |
| **Não é** | Um bug de `skipProseLine`. O filtro de prosa PDF ficou reduzido a `^%PDF-` / `^%%EOF` (suficiente para o falso positivo do fake PDF); a remoção de `BT (` / `endobj` eliminou o falso negativo por skip. O residual está em `selectCodigo`. |

Não alterar `selectCodigo` só por este cenário sintético sem evidência num documento real.

## Ops staging / produção — S3

CI e dev **permanecem** em `OBJECT_STORAGE_DRIVER=local` (omisso = local). Não forçar S3 no CI.

### Variáveis

| Var | Obrigatória com driver `s3` | Notas |
|---|---|---|
| `OBJECT_STORAGE_DRIVER` | sim (`s3` ou `s3-compatible`) | Default `local`. Sem isto, `S3_*` são ignoradas. |
| `S3_ENDPOINT` | sim | URL S3-compatible (R2, MinIO, AWS, Spaces) |
| `S3_BUCKET` | sim | Bucket já criado; este slice não provisiona infra |
| `S3_REGION` | não | Default `auto`. AWS: `eu-west-1` etc. R2: `auto` |
| `S3_ACCESS_KEY_ID` | sim | Também aceita `AWS_ACCESS_KEY_ID` |
| `S3_SECRET_ACCESS_KEY` | sim | Também aceita `AWS_SECRET_ACCESS_KEY` |
| `S3_KEY_PREFIX` | não | Prefixo de object key (`lumen-staging`). Alias: `S3_PREFIX` |
| `S3_FORCE_PATH_STYLE` | não | Default path-style (S3-compatible). `0` → virtual-hosted |
| `S3_VIRTUAL_HOSTED_STYLE` | não | `1` para AWS virtual-hosted; prevalece sobre `S3_FORCE_PATH_STYLE` |
| `OBJECT_STORAGE_LIVE_S3` | não | `1` para smoke real no `test:f1`. **Nunca** no CI |

Exemplo (Cloudflare R2 / MinIO):

```env
OBJECT_STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=lumen-staging
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_KEY_PREFIX=lumen-staging
S3_FORCE_PATH_STYLE=1
```

AWS S3 (virtual-hosted):

```env
OBJECT_STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com
S3_BUCKET=lumen-prod
S3_REGION=eu-west-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_VIRTUAL_HOSTED_STYLE=1
```

### Comportamento

- Contrato `put/get/exists` **não muda**. A key continua a ser sha256 hex (`/^[a-f0-9]{64}$/`).
- Object key no bucket: `{prefix?}{tenantId}/{sha256}.bin`.
- `tenant_id` no path é **canónico e injetivo** (Astra A2): `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` sem `..`. Recusado na **criação** do tenant (`provisionTenant`); local/S3 **não** substituem caracteres por `_` (isso colidia `a/b` com `a_b`). Namespace = identidade do id válido. Sem dados reais de produção LUMEN — correcção directa, sem migração de blobs.
- Sem `S3_ENDPOINT` + `S3_BUCKET` + keys → `object_storage_unconfigured` (500) no **uso**, não no boot. Dev: `OBJECT_STORAGE_DRIVER=local`.
- Bucket inexistente (`NoSuchBucket`) → `object_storage_s3_error` (502), **não** `exists=false`.
- Não copia blobs já gravados em `data/content`. Ligar S3 **antes** de ingestão real nesse ambiente. Hashes locais antigos 404 se o driver passar a `s3`.
- Segredos só em env/secret store; nunca no repo.

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

CI: stub/local. Smoke contra bucket real (opt-in):

```bash
OBJECT_STORAGE_LIVE_S3=1 OBJECT_STORAGE_DRIVER=s3 S3_ENDPOINT=... S3_BUCKET=... \
  S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... bun run test:f1
```

## Validação local MinIO

**MinIO = só dev/local.** Este cutover valida o adapter S3-compatible (`OBJECT_STORAGE_DRIVER=s3` + `S3_*`, path-style) contra um endpoint local. **Não é staging/prod ready.** Não valida flags R2/AWS de produção. Não hardcoda MinIO no domínio.

### Como correr

```bash
docker compose -f docker-compose.minio.yml up -d
./scripts/dev-minio-smoke.sh
```

O smoke: compose up → espera healthy → `createbucket` **idempotente** (`mc mb --ignore-existing`) → `OBJECT_STORAGE_LIVE_S3=1` + env MinIO → evidência **put → exists → get** (bytes iguais). Driver permanece `s3`. Endpoint inválido / credenciais ausentes **não** fazem fallback silencioso para `LocalObjectStorage`.

Env (bloco comentado em `.env.template` — “Local MinIO (dev only)”):

```env
OBJECT_STORAGE_DRIVER=s3
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=lumen-dev
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_KEY_PREFIX=lumen-dev
S3_FORCE_PATH_STYLE=1
```

### Histórico `data/content` — fora deste cutover

Blobs históricos em `data/content` **não são migrados**. Sem dual-read, sem dual-write, sem copy. Uma migração futura é uma **decisão explícita**, não parte deste slice.

### Limitações conhecidas

- Port continua `put/get/exists` (sem delete/list)
- CI permanece `OBJECT_STORAGE_DRIVER=local` (omisso)
- R2/AWS staging/prod **não** estão validados aqui
- **Não production-ready** — só integração técnica local

## API (resumo)

- `POST /api/f1/documents/upload` (multipart: `kind` + `file`; 400 se >10MB ou tipo fora de csv/xlsx/xls/txt/pdf/jpeg/png/webp/gif)
- `GET  /api/f1/documents`
- `contentHash` em blob/register/extract é só sha256 hex (`/^[a-f0-9]{64}$/`)
- `POST /api/f1/documents`
- `POST /api/f1/documents/:id/extract`
- `POST /api/f1/documents/:id/extract-from-file` (CSV/Excel/texto/PDF/foto → `StructuredExtraction`; OCR fraco → `human_review`)
- `GET  /api/f1/documents/:id/lines`
- `POST /api/f1/documents/:id/lines/:lineId` (editar payload; AuditEvent; só `pending_review`)
- `POST /api/f1/documents/:id/confirm-fracoes`
- `POST /api/f1/documents/:id/confirm-contactos` (não cria Invitation)
- `POST /api/f1/documents/:id/iban-proof`
- `GET  /api/f1/fracoes`
- `POST /api/f1/budgets`
- `POST /api/f1/budgets/:id/approve`

## Adaptadores

| Port | Default (dev/CI) | Staging / prod |
|---|---|---|
| Object storage | `LocalObjectStorage` (`CONTENT_BLOB_ROOT` / `data/content`) | `OBJECT_STORAGE_DRIVER=s3` + `S3_*` (fail-closed sem credenciais; sem migração massiva) |
| OCR/LLM | stub determinístico (texto embutido no PDF/foto) | `F1_OCR_ENDPOINT` (+ `F1_OCR_API_KEY`) — documentado, não exigido no CI |
