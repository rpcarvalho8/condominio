# F1 — Estado de implementação

**Branch:** `cursor/f1-ocr-pdf-foto-ui-admin`  
**Base documental:** `docs/lumen/06-FATIAS.md` (F1 — Ingestão + Constituição)

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
| Object storage adapter | ✅ | Port `put/get/exists`; local default; S3-compatible **path** via env, sem credenciais em CI |
| Confirmação linha a linha de frações | ✅ | Σ permilagens = 1000‰ |
| Contactos (draft + confirmação) | ✅ | Sem convites |
| Comprovativo IBAN | ✅ | `retention_class = personal_document` |
| Orçamento anual + FCR ≥10% → obligations | ✅ | Rateio por permilagem |
| Rotas `/api/f1/*` | ✅ | Membership + manager (Admin/PlatformAdmin) fail-closed + AuditEvent |
| UI admin de revisão | ✅ | `/f1` — listar, excerto visível, editar, confirmar |

## Ainda fora / não é deste slice

- Ligar produção a S3 (só o adapter; default continua local `data/content`)
- Provider OCR pago em CI (opcional via `F1_OCR_ENDPOINT` + `F1_OCR_API_KEY`)
- Convites (F3) — confirmação de contactos **não** envia (ADR-017)
- Auto-confirmação a partir de OCR — **proibido**

## Como testar

```bash
cd packages/web && bun run test:f1 && bun run test:f2 && bun run test:f3
```

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

| Port | Default (dev/CI) | Opcional |
|---|---|---|
| Object storage | `LocalObjectStorage` (`CONTENT_BLOB_ROOT` / `data/content`) | `OBJECT_STORAGE_DRIVER=s3` + `S3_*` (fail-closed sem credenciais; **não** migra produção) |
| OCR/LLM | stub determinístico (texto embutido no PDF/foto) | `F1_OCR_ENDPOINT` (+ `F1_OCR_API_KEY`) — documentado, não exigido no CI |
