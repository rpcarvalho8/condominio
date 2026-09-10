# Auditoria complementar à v6.1 — Análise antes de implementação

**Versão:** complementar à v6.1 | **Data:** 2026-09-10  
**Branch de referência documental:** `cursor/lumen-v61-docs-1c40`  
**Estado:** análise fechada; implementação de RecordingSegment na branch `cursor/reuniao-recording-segments-1c40` (auditoria final 2026-09-10)

Este documento responde à Parte P do pedido. A v6.1 permanece fechada: não se reabre a arquitectura geral nem se inicia F0 por iniciativa própria.

---

## A. Concordo

1. **Linguagem (Parte A).** A documentação deve soar a português de Portugal claro e humano, sem mudar o significado das decisões já fechadas.
2. **Convocatória por condómino (Parte B).** O meio não é uniforme: art. 1432.º n.º 1 (carta registada / aviso com recibo) e n.ºs 2–3 (email só se vontade lavrada em acta com endereço e recibo de receção). Separar convocatória de comunicação posterior de deliberações (n.º 9) é correcto.
3. **UNKNOWN → HUMAN REVIEW**, nunca AUTO SEND.
4. **Gravação ≠ fim da reunião (Partes C–O).** O bug histórico (cada ciclo MediaRecorder + “Criar reunião” = novo `INSERT`) foi corrigido: `POST /open` + `POST /:id/segments` + `POST /:id/end-meeting`. Interrupção técnica não cria nova Reunião.
5. Separar `Reuniao` de `RecordingSegment`, com persistência progressiva **no cliente** (IndexedDB + upload resumível). Persistência progressiva no servidor fica como requisito futuro se o piloto exigir zero perda de áudio.
6. Intenção humana ≠ falha técnica tem de existir no domínio/estado, não só no UI.
7. Uma Acta / uma Reuniao, vários segmentos ordenados para STT.
8. Retenção de áudio v6.1 mantém-se (hard-delete após Acta `APPROVED`).
9. `AuditEvent` nas transições relevantes, sem spam.

---

## B. Discordo / limito

| Ponto | Posição |
|-------|---------|
| Nomes exactos `SCHEDULED → STARTED → RECORDING → …` | Concordo com a ideia; os nomes finais alinham-se ao domínio LUMEN e, no código actual da Fonte, aos estados existentes (`rascunho`, `processando_audio`, …) sem inventar máquina paralela desnecessária. Proposta canónica abaixo. |
| Criar entidade `ConvocationDeliveryPreference` | Desnecessário como entidade própria. Preferência = campos no `Membership` (ou Person+Membership) + evidência de autorização (acta/data). Entidade nova só se o histórico de mudanças o exigir — ADR-026: não criar entidade enterprise cedo. |
| “O LUMEN determina o meio juridicamente aplicável” | O sistema aplica configuração/regra validada e bloqueia AUTO quando `UNKNOWN`. Não “decide direito” sozinho. |
| Resolver só no frontend | Discordo de o fazer só no frontend — mas a primeira correcção útil liga sessão de gravação a `reuniaoId` e modelo de segmentos no backend. |
| Media streaming sofisticado | Fora de âmbito. Segmentos + chunks existentes bastam. |
| Contagem dos 10 dias (envio vs receção) | Jurisprudência divergente (ex.: Ac. TC 80/2005 vs TR Porto 2019). Não fechar no produto → `legal validation required`. |

---

## C. Questões legais (`legal validation required`)

1. Contagem exacta dos 10 dias de antecedência (expedição vs receção).
2. Validade prática do recibo de receção por email (n.º 3) e consequências se o condómino não enviar recibo.
3. Meios alternativos além de carta registada / aviso com recibo / email autorizado.
4. Relação entre preferência de convocatória e preferência de comunicação de deliberações (n.º 9) — podem coincidir ou divergir; validar se o modelo as trata como preferências distintas (proposta: sim).
5. Retenção de áudio com múltiplos segmentos — política DPO já na v6.1; confirmar se a eliminação pós-`APPROVED` cobre todos os segmentos de uma vez.

---

## D. Alterações documentais propostas

| Ficheiro | Alteração |
|----------|-----------|
| Todos os `docs/lumen/*` | Passagem de linguagem PT-PT (Parte A) |
| `02-DOMINIO.md` | Preferência de convocatória no Membership; `ConvocationDispatch`; distinção convocatória ≠ comunicação de deliberações; `RecordingSegment`; ciclo de vida da `Reuniao`; invariantes |
| `06-FATIAS.md` | F5: convocatória por meio; gravação multi-segmento |
| `04-PORTAS.md` | Comunicação / evidência de envio (sem misturar com deliberações) |
| `ADR-LOG.md` | ADR-041 (convocatória), ADR-042 (RecordingSegment / reunião contínua) |
| `LUMEN-diagramas-arquitetura.md` | Sequência gravação multi-segmento; nota convocatória |
| `PRODUCTION-GATES.md` | Gate Legal: convocatória art. 1432.º |
| `AUDITORIA-COMPLEMENTAR-V61.md` | Este ficheiro |
| `00-INDICE.md` | Referência a este documento |

---

## E. Alterações de domínio propostas

### Convocatória

Campos em `Membership` (não entidade nova):  
`convocation_channel`: `registered_mail` | `authorized_email` | `other_admissible` | `unknown`  
`convocation_email` (se email), `authorized_in_acta_id`, `authorized_at`

`ConvocationDispatch` (registo de envio; pode ser tabela de outbox/audit tipada): meio, destino, timestamps, estado, recibo, versão da convocatória, actor, falhas, reenvio.

`DeliberationNoticeDispatch` separado (art. 1432.º n.º 9).

Regra: se canal `unknown` ou autorização em falta → HUMAN REVIEW, sem envio automático.

### Gravação

Estados canónicos da `Reuniao` (LUMEN):

`DRAFT → IN_PROGRESS → ENDED → (processamento STT/Acta…)`

Sub-estado de gravação (na reunião ou derivado dos segmentos):

`recording` | `interrupted` | `idle_open` | (termina só com `ENDED`)

`RecordingSegment`: `reuniao_id`, `ordinal`, `started_at`, `ended_at`, `reason_ended` (`user_stop_segment` | `technical_interrupt` | `user_end_meeting`), `storage_path`, `byte_size`, `status`.

Invariante: falha técnica nunca transita a reunião para `ENDED`.

---

## F. Alterações de código propostas

Branch nova (código): `cursor/reuniao-recording-segments-1c40` a partir de `produto` (não `dev`).

Ficheiros afectados:

- `packages/web/src/api/database/schema.ts` — tabela `recording_segments`; campos/estado em `reunioes`
- `packages/web/src/api/routes/reunioes.ts` — criar reunião ao iniciar; append segmento; terminar; listar segmentos; STT sobre segmentos ordenados
- `packages/web/src/web/lib/RecordingContext.tsx` — `reuniaoId`; interrupt vs end; retomar mesma reunião
- `packages/web/src/web/lib/recording-idb.ts` — persistir `reuniaoId` / `segmentOrdinal` na sessão
- `packages/web/src/web/pages/reunioes.tsx` + `RecordingBar.tsx` — UX “Retomar gravação” / “Terminar reunião”
- Testes unitários / de domínio para os 6 cenários pedidos

Não misturar este fix com F0 multi-tenant.

---

## G. Testes

1. Gravação normal → 1 Reuniao, 1 segmento  
2. Interrupção + retoma → 1 Reuniao, 2 segmentos  
3. Várias interrupções → 1 Reuniao, N segmentos  
4. Falha de rede → segmento persistido; reunião aberta; retoma  
5. Browser fecha → recuperação IDB + `reuniaoId`; Retomar; sem nova reunião  
6. Só “Terminar reunião” → `ENDED`; falha técnica ≠ `ENDED`

---

## H. Riscos que permanecem

1. Limites do browser (iOS Safari) podem impedir retoma automática sem gesto do utilizador — UI deve pedir “Retomar”.  
2. Concatenação STT de vários content-types (webm/mp4) pode exigir re-encode ffmpeg por segmento (já há caminho similar no STT).  
3. Upload parcial se o dispositivo morrer a meio do chunk — mitigado por IDB + segmentos curtos, não eliminado.  
4. Acta ainda é fluxo separado na app Fonte (`atas` sem FK a `reunioes`) — fora do âmbito mínimo deste fix; no domínio LUMEN Acta ↔ Reuniao já está modelado.  
5. Validação legal da convocatória continua gate de advogado.

---

## Decisão de implementação (após esta análise)

| Âmbito | Acção |
|--------|--------|
| Documentação (A, B, domínio segmentos, ADRs, linguagem) | Implementar na branch `cursor/lumen-v61-docs-1c40` |
| Código gravação multi-segmento | Implementar na branch `cursor/reuniao-recording-segments-1c40` |
| F0 / orquestra / multi-tenant | Não iniciar |
| Fechar contagem dos 10 dias / recibo email | Não — `legal validation required` |

---

## Pós-implementação — auditoria final RecordingSegment (2026-09-10)

Branch código: `cursor/reuniao-recording-segments-1c40`. Documentação alinhada em ADR-042 (emenda), `02-DOMINIO`.

| Área | Estado após correcção |
|------|------------------------|
| Domínio 1 Reunião / N segmentos | Implementado |
| Tenant isolation (`tenant_id` + filtro servidor) | Implementado (defesa; ADR-016 mantém 1 BD/tenant) |
| Ordinal concorrente + UNIQUE | Implementado + teste |
| Testes integração (8 casos) | Implementado |
| Resiliência áudio | MVP documentado: IDB cliente; sem falsa garantia servidor |
| Timestamps | Semântica documentada (receção vs client opcional) |
| Estados Reunião / Segmento | Clarificados (`terminada` não usada; segmentos persistidos `closed`) |
| end-meeting idempotente | Implementado |
| STT async job | Adiado a F0/ADR-038 (Vite corta background); sync HTTP na Fonte |
| AuditEvent | Tabela + eventos de gravação |
| Migration SQL (não só db:push) | `migrations/0001` + script |

**Veredicto documental:** GO para merge do código de RecordingSegment **com** a limitação MVP de áudio e STT-no-HTTP explicitamente aceites até F0/piloto.
