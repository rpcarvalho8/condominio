# F1 — Estado de implementação

**Branch:** `cursor/f1-ingestao-ficheiros-1c40`  
**Base documental:** `docs/lumen/06-FATIAS.md` (F1 — Ingestão + Constituição)

## Critério do plano

> admin sobe PDF/Excel/foto, confirma **linha a linha** (excerto de origem visível), frações existem com `Obligation`s calculadas.

## O que está implementado

| Capacidade | Estado | Notas |
|---|---|---|
| Upload real de ficheiro (bytes em disco) | ✅ | `POST /api/f1/documents/upload` + content-addressed blob; max 10MB; só csv/xlsx/xls/txt |
| `content_uploads` + `ingest_documents` | ✅ | Upload ≠ confirmação |
| Extracção CSV/Excel → `extract_lines` | ✅ | Determinística; `sourceExcerpt` = linha de origem |
| Extracção texto com padrões ‰ | ✅ | Heurística; sem OCR |
| Confirmação linha a linha de frações | ✅ | Σ permilagens = 1000‰ |
| Contactos (draft + confirmação) | ✅ | CSV contactos + confirmação; sem convites |
| Comprovativo IBAN | ✅ | `retention_class = personal_document` |
| Orçamento anual + FCR ≥10% → obligations | ✅ | Rateio por permilagem |
| Rotas `/api/f1/*` | ✅ | Membership + manager |

## Ainda fora do critério pleno / adaptadores seguintes

Este PR **não** fecha a F1. Falta, de propósito:

- Extrator LLM/OCR real de PDF binário e foto (substituível pelo mesmo `StructuredExtraction`)
- Object storage cloud (hoje: disco local `data/content`)
- UI admin de revisão linha a linha
- Convites (F3)

## Como testar

```bash
cd packages/web && bun run test:f1
```

## API (resumo)

- `POST /api/f1/documents/upload` (multipart: `kind` + `file`; 400 se >10MB ou tipo fora de csv/xlsx/xls/txt)
- `contentHash` em blob/register/extract é só sha256 hex (`/^[a-f0-9]{64}$/`)
- `POST /api/f1/documents`
- `POST /api/f1/documents/:id/extract`
- `POST /api/f1/documents/:id/extract-from-file`
- `GET  /api/f1/documents/:id/lines`
- `POST /api/f1/documents/:id/confirm-fracoes`
- `POST /api/f1/documents/:id/confirm-contactos`
- `POST /api/f1/documents/:id/iban-proof`
- `GET  /api/f1/fracoes`
- `POST /api/f1/budgets`
- `POST /api/f1/budgets/:id/approve`
