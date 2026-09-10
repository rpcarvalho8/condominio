# Implementação RecordingSegment — notas alinhadas ao código (Fonte)

**Branch código:** `cursor/reuniao-recording-segments-1c40`  
**ADR:** ADR-042 (não reabre v6.1)

## Domínio (inalterado)

```text
Reunião (negócio) 1 ─── N RecordingSegment (técnico)
```

Interrupção técnica → novo segmento, **mesmo** `reuniaoId`.  
Só «Terminar reunião» (`POST /:id/end-meeting`) inicia o processamento.

## Tenant isolation

- Arquitectura LUMEN: **1 BD por tenant** (ADR-016).
- Nesta app Fonte: coluna `reunioes.tenant_id` carimbada no servidor via `TENANT_ID` env ou NIF do condomínio — **nunca** do cliente.
- Todos os endpoints filtram `id + tenantId`.
- `RecordingSegment` herda isolamento pela FK `reuniao_id`.

## Ordinal

- `UNIQUE (reuniao_id, ordinal)`
- Alocação: `MAX(ordinal)+1` + retry em colisão UNIQUE (não `count+1` sem rede de segurança)

## Timestamps

| Campo | Semântica |
| ----- | --------- |
| `startedAt` / `endedAt` | Momento de **receção/persistência no servidor** |
| `clientStartedAt` / `clientEndedAt` | Opcionais; clock do cliente se enviado |

Não afirmar precisão temporal de parede do MediaRecorder só com `startedAt`/`endedAt`.

## Estados Reunião

```text
em_curso → (Terminar) → processando_audio → rascunho → aprovada
                              ↓
                         erro_audio → (reprocessar) → processando_audio
```

`terminada` **não é usada** no fluxo actual (legado/reservado).

## Estados RecordingSegment

API actual só **insere** segmentos `closed` (após upload).  
`open` existe no domínio in-memory / futuro; não há segmentos abertos no servidor durante a gravação.

## Resiliência de áudio (honestidade)

| Camada | O que existe |
| ------ | ------------ |
| Cliente | IndexedDB chunks ~1s + recuperação após refresh/crash de tab |
| Upload | Upload resumível do ficheiro **já montado** |
| Servidor | Segmento completo após `POST /segments` |

**Limitação MVP (Opção 1):** se o browser/OS matar o processo **antes** dos chunks IDB serem montados e enviados, o áudio desse segmento pode perder-se.  
Isto **não** cria nova Reunião.  
**Não** declarar “gravação contínua resiliente no servidor”.

Persistência progressiva servidor (chunks → segmento parcial) = requisito futuro de produção se o piloto exigir zero perda.

## Jobs / STT / LLM

- `end-meeting` é **idempotente** (status + `processingGeneration` + `withIdempotency`).
- STT consome segmentos por ordinal → **uma** transcrição → LLM → rascunho.
- Na Fonte, STT/LLM ainda correm **no pedido HTTP** (Vite corta background). F0 (ADR-038) deve migrar para job persistente — **não** criar segunda infra de jobs agora.

## AuditEvent

Tabela `audit_events` com tipos: `meeting_opened`, `recording_segment_closed`, `recording_interrupted`, `recording_upload_failed`, `meeting_ended`, `recording_processing_*`.

## Migration

```bash
cd packages/web && bun run db:migrate:reuniao-segments
```

Script: `scripts/migrate-reuniao-recording-segments.ts`  
SQL: `migrations/0001_reuniao_recording_segments.sql`
