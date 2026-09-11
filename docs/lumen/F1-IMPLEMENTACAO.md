# F1 — Estado de implementação (vertical slice)

**Branch:** `cursor/f1-ingestao-constituicao-1c40`  
**Base documental:** `docs/lumen/06-FATIAS.md` (F1 — Ingestão + Constituição)

## O que está implementado

Vertical slice no kernel multi-tenant (`packages/web`), sobre F0:

| Capacidade | Estado | Notas |
|---|---|---|
| Registo de documento ingerido (`ingest_documents`) | ✅ | Upload ≠ confirmação |
| Extração consultiva → `extract_lines` | ✅ | Exige `sourceExcerpt`; sem LLM real neste slice (entrada estruturada) |
| Confirmação linha a linha de frações | ✅ | Só depois nascem `constitution_fracoes` |
| Σ permilagens = 1000‰ | ✅ | Validado no lote confirmado |
| Contactos (draft + confirmação) | ✅ | Nunca dispara convites |
| Comprovativo IBAN | ✅ | `retention_class = personal_document` |
| Orçamento anual + FCR ≥10% | ✅ | Rejeita FCR insuficiente |
| Aprovação → `obligations` por fração | ✅ | Rateio por permilagem; idempotente |
| Audit + domain events | ✅ | Eventos de confirmação / aprovação |
| Rotas `/api/f1/*` | ✅ | Membership + manager |
| Migration `0005_f1_constitution.sql` | ✅ | Aplicada via `applyF1ConstitutionSchema` |

## O que fica de fora deste slice (explícito)

- Extrator LLM/OCR real de PDF/foto (substituível por adaptador que produz `StructuredExtraction`)
- UI admin de revisão linha a linha
- Ligação Enable Banking / PSD2
- Convites (F3)
- Ledger completo / Payments / Allocations (F2)

## Como testar

```bash
cd packages/web && bun test src/api/f1.integration.test.ts
```

## API (resumo)

- `POST /api/f1/documents`
- `POST /api/f1/documents/:id/extract`
- `GET  /api/f1/documents/:id/lines`
- `POST /api/f1/documents/:id/confirm-fracoes`
- `POST /api/f1/documents/:id/confirm-contactos`
- `POST /api/f1/documents/:id/iban-proof`
- `GET  /api/f1/fracoes`
- `POST /api/f1/budgets`
- `POST /api/f1/budgets/:id/approve`
