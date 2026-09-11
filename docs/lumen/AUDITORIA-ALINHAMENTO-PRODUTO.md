# Auditoria de alinhamento — branch `produto` vs LUMEN v6.1

**Data:** 2026-09-10  
**Branch auditada:** `produto` @ `7867ff6` (`docs(lumen): v6.1 + alinhamento RecordingSegment pós-implementação (#3)`)  
**Pacote canónico:** `docs/lumen/` v6.1 ACEITE  
**Precedência aplicada:** ADR-LOG (aceite) > `02-DOMINIO` > `06-FATIAS` > diagramas > resto  
**Âmbito:** código de produto em `packages/web` (API Hono + UI React). Arquivos `_archive/` e artefactos de build ignorados salvo quando encodam config errada.  
**Fora de âmbito desta auditoria:** implementar correcções.

---

## 1. Executive summary

**Veredicto: a branch `produto` não está pronta para piloto Essencial (F0–F3).**  
É a app **Fonte** (condomínio único, Urbanização da Fonte), com um enxerto recente de `RecordingSegment` (ADR-042) nas reuniões admin. O Domain Kernel LUMEN (F0) **não existe**. O Finance Kernel (F2) **contradiz** o domínio. F4/F5/F6-style (atas com voto, tickets LLM, inbox Gmail, STT/LLM, Enable Banking) **já estão no caminho crítico** antes de F0–F2.

| Pergunta | Resposta |
|---|---|
| Pilot launch (F0–F3 Essencial)? | **NO-GO.** F0 incompleto; F1 vertical slice ausente; F2 é `Quota.pago`; F3 sem `Invitation`/`Membership`/PWA; saldo do portal não vem do Ledger. |
| Comercial geral (F5 + gates)? | **NO-GO.** F5 contradiz a máquina de Acta/`ResolutionRule`; gates de produção não têm evidência. |
| Dinheiro / votos / efeitos legais em produção? | **NO-GO** (`00-INDICE`, ADR-039, `PRODUCTION-GATES.md`). O código já marca quotas pagas, envia recibos e abre votação. |
| O que está alinhado? | `RecordingSegment` nas reuniões admin (ciclo contínuo, ordinal UNIQUE, interrupção ≠ fim, IDB+upload resumível, `tenant_id` carimbado no servidor). Isto é **órgão Fonte + ADR-042**, não o Domain Kernel. |
| Risco principal | Continuar a expandir Fonte (banco, atas, LLM) enquanto se fala de LUMEN. `05-TRANSPLANTE.md`: *«Não transplantar o condomínio Fonte hardcoded como se fosse o produto.»* |

**Leitura em uma frase:** a documentação v6.1 está congelada e GO para *implementar* F0; o código em `produto` ainda opera o modelo pré-LUMEN (`user.role` plano, `Quota.pago`, FCR = 10% do pagamento, uma BD, jobs `setTimeout`).

---

## 2. Phase scorecard F0 → F6

Legenda: **done** = critérios de conclusão demonstráveis; **partial** = existe fragmento; **missing** = exigido e ausente; **premature** = F4/F5/F6-style no código antes de F0–F2 sólidos; **contradicts** = viola invariante/ADR.

| Fase | Score | Critério LUMEN | Código em `produto` |
|---|---|---|---|
| **F0** Plataforma + Domain Kernel | **partial / missing** (não concluído) | 10 propriedades testáveis em `06-FATIAS.md` | 0/10 demonstradas. better-auth existe com `user.role`. `audit_events` só em reuniões. `idempotency_keys` HTTP opcional. Sem `Person`/`Membership`/`TenantDirectory`/Outbox/Policy Engine/Domain Services. |
| **F1** Ingestão + Constituição | **missing** | PDF/foto/CSV → confirmação linha a linha → `Person`/`Membership`/`Fracao`/`Obligation` | Import CSV de movimentos + seeds Fonte. Sem upload de regulamento com excerto visível. `fracoes.proprietario_*` é o modelo. |
| **F2** Financeiro / Ledger | **contradicts** (+ premature vs F0) | Obligation/Payment/Allocation/Ledger + hash-chain + cash_status | `quotas.pago` boolean; FCR `valor * 0.1`; saldos âncora em memória; Enable Banking já no boot. |
| **F3** Onboarding + PWA Essencial | **missing** (+ contradicts no portal) | `Invitation` + verificação de contacto + Membership + saldo Ledger + PWA | Login email/password; admin cria user com role; portal lê `Quota.pago`; **já vota atas**; sem PWA/service worker; UI dark/blue ≠ Sevilla. |
| **F4** Operações + contratos leves | **premature** (órgãos Fonte) | Tickets, Decision Brief, `AuthorityRule`/`Approval`, Contract leve, reuniões admin | Tickets+foto+LLM; fornecedores; reuniões admin+STT (RecordingSegment alinhado ADR-042). Sem Contract/`AuthorityRule`/`Approval`. |
| **F5** Assembleia / Governança | **premature + contradicts** | `ResolutionRule`, Acta até `PUBLISHED`, convocatória por Membership, 1 Acta/Reunião | Tabela `atas` **desligada** de `reunioes`. Estados `rascunho`/`aguardando_votos`/`aprovada`. Quórum hardcoded 50%. Voto no portal. Sem `ConvocationDispatch`. |
| **F6** Orquestra LLM | **premature** (fragmentos) | Maestro + validação em camadas; LLM fora do núcleo financeiro | Groq no match bancário, tickets, emails, atas, reuniões. Sem Maestro/Risk Engine/KB legal. `03-ORQUESTRA.md`: *não implementar antes de tenant + ingestão.* |

### F0 — 10 propriedades testáveis (`06-FATIAS.md`)

| # | Propriedade | Estado | Evidência |
|---|---|---|---|
| 1 | Tenant A nunca consulta/altera/jobs no Tenant B | **FAIL** | Uma BD (`database/index.ts`); `getCurrentTenantId()` só carimba `reunioes`. Rotas de frações/quotas/dashboard sem filtro de tenant. |
| 2 | Membership revogada perde auth de imediato | **FAIL** | Sem `Membership`. Auth = `user.role` + sessão better-auth. |
| 3 | Toda mutation relevante → `AuditEvent` | **FAIL** | `writeReuniaoAudit` só em reuniões. Quotas, users, bank, atas: sem audit kernel. |
| 4 | Job duplicado (retry) sem efeito duplicado | **FAIL** | Crons `setTimeout` em `api/index.ts` sem chave de job. `withIdempotency` só se o cliente enviar header. |
| 5 | Upload repetido não corrompe estado | **partial** | `import_logs.fileHash` e uploads resumíveis existem; não há invariante F0 testada. |
| 6 | Migration N tenants vX→vX+1 com falhas por tenant | **FAIL** | Sem `TenantDirectory`. Uma migration SQL ad-hoc (`0001_reuniao_recording_segments.sql`). |
| 7 | Backup/restore de um tenant testado | **FAIL** | Ausente. |
| 8 | Secrets/credenciais bancárias nunca em logs | **parcial / risco** | Callbacks logam `code=` truncado (`bank.ts` ~556). Sem política F0 nem testes. |
| 9 | Request sem tenant válido → 403 fechado | **FAIL** | Sem middleware tenant. `GET /api/fracoes`, `GET /api/quotas`, `GET /api/dashboard`, `POST /api/seed` sem `requireAuth`. |
| 10 | Efeitos async críticos idempotentes e observáveis | **FAIL** | Bank sync no boot + cron + silent fetch no `ProtectedRoute`. Email via CLI `send-email` fire-and-forget. STT no pedido HTTP (`reunioes.ts` ~430). |

**Conclusão F0:** não congelar Domain Kernel; não avançar F2 «de verdade» nem piloto.

---

## 3. Gap catalog

Cada item: **severidade** · **LUMEN** · **ficheiro:linha / símbolo** · comportamento actual · comportamento exigido · **próxima fatia**.

WIP LUMEN: no máximo **duas** frentes F0 em paralelo (`06-FATIAS.md` § Capacidade).

---

### 3.1 F0 — Domain Kernel (blockers)

#### G-001 — Identidade: `user.role` plano em vez de Person + Membership  
**Severidade:** blocker  
**LUMEN:** ADR-006, ADR-031; `02-DOMINIO` Identidade; `01-CONSTITUICAO`; F0 bootstrap roles `Owner | CoOwner | Proxy | Admin | PlatformAdmin | Fiscalizacao`.  
**Código:**

```8:11:packages/web/src/api/database/auth-schema.ts
  role: text("role").notNull().default("condómino"), // "admin" | "condómino"
  fracaoId: text("fracao_id"),                        // linked fração for condómino users
```

`requireAdmin` (`middleware/auth.ts:19`): `user.role !== "admin"`.  
`auth.ts` additionalFields: `role` + `fracaoId` no user.  
`admin-users.ts:54-55`: `role: body.role ?? "condómino", fracaoId: body.fracaoId`.  
`setup.ts:33`: first user → `role: "admin"`.  
`useIsAdmin()` (`web/lib/auth.ts:31`): `(session?.user as any)?.role === "admin"`.

**Actual:** enum de 2 valores; uma fração por user; Person inexistente.  
**Exigido:** `Person` 1—N `Membership` (tenant, fração opcional, Role, Scope, estado activo/revogado). `Fiscalizacao` no conjunto inicial (não entidade `ConselhoFiscal`).  
**Fatia:** F0-A Domain Kernel v0.1 (schema + roles seed). Sem UI de conselho fiscal.

#### G-002 — Sem `TenantDirectory` nem 1 BD por condomínio operacional  
**Severidade:** blocker  
**LUMEN:** ADR-016; `02-DOMINIO` invariante 14; F0 item TenantDirectory.  
**Código:** `database/index.ts:5-10` — um `createClient({ url: DATABASE_URL })`.  
`lib/tenant.ts:16-20` — `TENANT_ID` env ou `CONDOMINIO.nif`; comentário admite «app Fonte (um processo ↔ uma BD)».  
`lib/condominio.ts:1-12` — NIF/IBAN/email da Urbanização da Fonte hardcoded.

**Actual:** single-tenant; `tenant_id` só em `reunioes`/`audit_events`.  
**Exigido:** registo central fora das BDs de tenant (`tenant_id`, `db_ref`, `schema_version`, `status`, backups, secrets). Provisionamento idempotente Turso.  
**Fatia:** F0-B TenantDirectory + provisionamento (2.ª frente F0, não em paralelo com mais de uma outra).

#### G-003 — Rotas Hono com SQL/Drizzle; sem Application/Domain Services  
**Severidade:** blocker  
**LUMEN:** ADR-010; F0 «nunca SQL/Drizzle nas rotas».  
**Código:** grep `UseCase|DomainService|Repository` → **0 hits**.  
`quotas.ts`, `fracoes.ts`, `dashboard.ts` (~2100 linhas), `identity-matrix.ts` `processarCascataAmortizacao` chamados a partir de rotas.

**Actual:** lógica de negócio nas rotas e em módulos «motor Fonte».  
**Exigido:** Hono → Use Cases → Domain Services (`SettlementEngine`, …) → Repositories.  
**Fatia:** F0-A — esqueleto de pastas + um use case (ex. criar Membership) como padrão; **não** reescrever dashboard nesta semana.

#### G-004 — Sem bus `DomainEvent` nem Job Queue / Outbox  
**Severidade:** blocker  
**LUMEN:** ADR-009, ADR-038; invariante 29; F0 critérios 4 e 10.  
**Código:** `api/index.ts:31-169` — IIFE `runBankSync()` no arranque; `scheduleBankSync` via `setTimeout`; crons de fecho/recibos/avisos/email IMAP.  
`ProtectedRoute.tsx:7-23` — `silentBankSync` fire-and-forget no browser.  
Tabela `idempotency_keys` + `withIdempotency`: **só HTTP**, e **sem header executa na mesma** (`idempotency.ts:33-35`).

**Actual:** efeitos laterais opacos; retry duplica; falha = `console.error`.  
**Exigido:** outbox + jobs idempotentes (email, OCR, bank sync, PDFs, STT) com estado, retry, correlação, `AuditEvent`/`DomainEvent`.  
**Fatia:** F0-C Job/Outbox (só depois ou em paralelo com F0-A; WIP ≤ 2). Migrar STT de reunião para job (ADR-042 emenda).

#### G-005 — `AuditEvent` incompleto e não universal  
**Severidade:** major (blocker para «F0 done»)  
**LUMEN:** ADR-009; `02-DOMINIO` AuditEvent: who/what/when/before/after/reason/source; invariante 10.  
**Código:** `schema.ts:398-416` — `type`, `entityType`, `entityId`, `actorUserId`, `payloadJson`. Faltam before/after/reason/source/request_id.  
Uso: apenas `writeReuniaoAudit` (`reuniao-audit.ts`). Falha de insert é swallow (`catch` + log).

**Actual:** audit de gravação; mutations financeiras/auth/atas sem rasto kernel.  
**Exigido:** audit na primeira mutation F0 e em todas as relevantes.  
**Fatia:** F0-A completar campos; F0-C emitir em jobs.

#### G-006 — Sem Policy Engine (esqueleto)  
**Severidade:** major  
**LUMEN:** F0 «Policy Engine (esqueleto)» para `SettlementPolicy` (F2), `AuthorityRule` (F4), `ResolutionRule` (F5); ADR-036 KB legal.  
**Código:** inexistente. Cascata hardcoded em `identity-matrix.ts` (`CascataAplicacao`) e `cartas-julho-2026.ts` «REGRA DE AMORTIZAÇÃO». Quórum em `configuracoes.atas_aprovacao_threshold_percent` (default `"50"`).

**Fatia:** F0-A tabela/versão vazia + interface; **não** implementar Settlement ainda.

#### G-007 — Auth: sessão ≠ Membership; fail-open sem tenant  
**Severidade:** blocker  
**LUMEN:** F0 auth better-auth ligada a Membership; critério 9 (403 sem tenant); ADR-006.  
**Código:** `index.ts:184` `authMiddleware` em `/api/*` **não exige** sessão (`middleware/auth.ts:4-8` seta `user` null e continua).  
Rotas **sem** `requireAuth`/`requireAdmin`: `GET/POST /fracoes` (`fracoes.ts:7-32`), `GET/POST /quotas` (`quotas.ts:9-38`), `GET /dashboard` (`dashboard.ts:1131`), `POST /seed` (`seed.ts:255`), `GET/PUT /configuracoes` (`configuracoes.ts:35-45`).

**Actual:** API de constituição/financeiro alcançável sem login (o UI protege; a API não).  
**Exigido:** fail closed; autorização via Membership; revogação imediata.  
**Fatia:** F0-A middleware tenant+auth **depois** do schema Membership; entretanto, fechar rotas com `requireAuth` é hardening Fonte, não o kernel.

#### G-008 — Independência de LLM no núcleo — já violada no caminho financeiro  
**Severidade:** blocker (F0 cross-cutting + F2)  
**LUMEN:** ADR-033, ADR-007; invariante 27; RAG nunca verdade financeira.  
**Código:** `llm-fallback.ts` — Groq identifica fração quando score < 55; `LLM_LEARN_THRESHOLD = 80` para auto-learn IBAN. Prompt: «Condomínio 7663». Chamado a partir do pipeline bancário.  
`identity-matrix.ts:106` — orçamentos «Single source of truth — importar daqui em dashboard.ts e no motor LLM».

**Actual:** Groq no caminho de match → `Quota.pago = true`.  
**Exigido:** saldo/dívida só Domain Services → Ledger; LLM no máximo candidato com confiança, nunca liquidação.  
**Fatia:** F0 não inclui Finance Kernel; **congelar** auto-learn LLM até F2. Não expandir Groq.

#### G-009 — Notificações F0: email sem retry/observabilidade de entrega  
**Severidade:** major  
**LUMEN:** ADR-035; F0 «Email = canal primário com envio / retry / estado de entrega / observabilidade. Não promete inbox.»  
**Código:** `ticket-email.ts:29`, `recibos.ts:404`, `avisos.ts:343` — `exec` CLI `send-email`. `avisos_enviados.resendMessageId` é legado pontual, não o canal F0. Sem `DomainEvent` de delivery.

**Fatia:** F0-C outbox de email (após kernel).

#### G-010 — Sem testes das propriedades F0  
**Severidade:** major  
**LUMEN:** F0 «Só com estas propriedades demonstradas».  
**Código:** apenas `reuniao-recording.test.ts` + `reuniao-recording.integration.test.ts`. `package.json` script `test:reuniao` só isso.

**Fatia:** F0-A testes de isolamento/revogação assim que Membership existir.

---

### 3.2 F1 — Constituição / ingestão

#### G-011 — Sem vertical slice F1 (regulamento → confirmação linha a linha)  
**Severidade:** blocker para F1 (não bloqueia começar F0)  
**LUMEN:** `06-FATIAS` F1; `04-PORTAS` Porta 1 passos 3–8; invariante 1 (excerto PDF visível).  
**Código:** `routes/import.ts` — CSV de movimentos → cria/marca `quotas`. UI `importar.tsx` = banco/CSV, não regulamento. Sem object storage pipeline «upload ≠ processamento» (F0 item 5) para PDFs de constituição.

**Exigido:** upload PDF/foto → extracção → tabela permilagem com excerto → persistir `Fracao` + mais tarde `Obligation`.  
**Fatia:** só **depois** de F0 kernel mínimo (sequência `06-FATIAS` itens 5–6).

#### G-012 — Proprietário vive na `Fracao`, não em Membership Owner  
**Severidade:** major (F0/F1)  
**LUMEN:** `02-DOMINIO` Constituição: «proprietário já não é campo desta entidade — é Membership role Owner».  
**Código:** `schema.ts:11-16` `proprietarioNome|Email|Nif|Morada|Telefone`.  
`identity-matrix.ts` `nomeProprietario`. Seeds e `admin-users` ligam `user.fracaoId`.

**Fatia:** F0-A + F1 persistência Membership.

#### G-013 — Hardcodes Fonte como constituição  
**Severidade:** major (legacy building-ops)  
**LUMEN:** `05-TRANSPLANTE` Excluir hardcodes; `07-BUSINESS-PLAN` Fonte ≠ LUMEN.  
**Código:** `condominio.ts` (morada, NIF `901932027`, IBAN, `urbanizacaofonte@gmail.com`).  
`identity-matrix.ts:107-128` `ORCAMENTO_*`, `ANCORA_SALDO_*`, `TOTAL_FRACOES = 33`.  
`cartas-julho-2026.ts` — «fonte de verdade» de dívidas Julho 2026.  
`dashboard.ts` / `configuracoes.ts` saldos default da Contas_2026.xlsx.  
`emailInbox.toEmail` default o Gmail da Fonte (`schema.ts:691`).

**Fatia:** F0-B tenant config; não portar âncoras para o kernel.

---

### 3.3 F2 — Financeiro (contradiz o domínio)

#### G-014 — `Quota.pago: boolean` é a verdade financeira  
**Severidade:** blocker  
**LUMEN:** ADR-003; invariante 3 «nunca colapsar num boolean `Quota.pago`».  
**Código:** `schema.ts:83` `pago`.  
`quotas.ts:173-178` `PATCH /:id/pagar` → `pago: true`.  
`quotas.ts:191-197` `desmarcar` → `pago: false` (**edita o passado** — viola Ledger append-only, invariante 4).  
`portal.ts:28-34` dívida = `!q.pago`.  
`identity-matrix.ts:1052-1072` cascata faz `update ... pago: true` só se o resto cobrir o valor **inteiro** (sem pagamento parcial).  
`dashboard.ts`, `relatorio.ts`, `avisos.ts`, `recibos.ts` todos filtram `pago`.

**Exigido:** Obligation / Payment / Allocation / LedgerEntry. Payment válido sem Allocation (ADR-012).  
**Fatia:** **não** nesta janela. F2 só após F0 + fatia F1 (`00-INDICE`, `06-FATIAS`).

#### G-015 — FCR = 10% de cada pagamento / da quota, não Obligation própria  
**Severidade:** blocker  
**LUMEN:** ADR-002; invariante 2; *«Nunca se retiram 10% de cada pagamento recebido.»*  
**Código:**

```82:82:packages/web/src/api/database/schema.ts
  fundoReserva: real("fundo_reserva"),        // 10% auto-calculated, stored separately
```

`transfer-match.ts:564` `fundoReserva: parseFloat((valor * 0.1).toFixed(2))` ao **inserir quota a partir do movimento**.  
`import.ts:230` idem se tipo condominio.  
`bank-movements.ts:352` idem.  
`seed.ts:375` `fundoReserva: Math.round(valor * 0.10 * 100) / 100`.  
`quota-tipos.tsx:134` UI: «10% da quota de condomínio … calculado automaticamente».  
`identity-matrix.ts:70` `fundoReserva: number; // 10% da quota (€)`.

**Exigido:** FCR gerado no orçamento anual como `Obligation` tipo FCR (≥10% da quota-parte nas **despesas**, art. 4.º DL 268/94), cobrada como rubrica.  
**Fatia:** F1 orçamento → F2 Obligations. Até lá, **não** tratar o campo `fundo_reserva` como lei.

#### G-016 — Saldos cacheados / âncora / cartas, não Ledger  
**Severidade:** blocker  
**LUMEN:** invariante 4; fluxo `Ledger → AccountingPeriod → Reports` (ADR-013).  
**Código:** `configuracoes` chave-valor `saldo_conta_corrente`, etc.  
`identity-matrix.ts:112-115` «NUNCA substituir [âncora] por saldo da DB».  
`cartas-julho-2026.ts:97-98` (comentário) substituição de permilagem × orçamento.  
`dashboard.ts` `recalcularSaldos` mistura âncora + cativos + `pago=0`.

**Exigido:** saldo = soma reconstruível do Ledger.  
**Fatia:** F2. Não «corrigir âncoras» como se fosse LUMEN.

#### G-017 — Sem Obligation / Payment / Allocation / LedgerEntry / hash-chain  
**Severidade:** blocker  
**LUMEN:** ADR-003, ADR-029; F2; secção Hash-Chain em `02-DOMINIO`.  
**Código:** tabelas inexistentes. `recibos.hashSha256` + `txHash` «on-chain futuro» (`schema.ts:103-104`) — **overclaim** oposto ao ADR-029 (*não é blockchain*).  
`bankMovements.allocations` é JSON legado, não `Allocation`.

**Fatia:** F2 após F0+F1.

#### G-018 — Cash: `numerário` sem `cash_status` / Fiscalizacao  
**Severidade:** major (F2; modelo já errado no enum)  
**LUMEN:** ADR-028; invariante 24.  
**Código:** `metodo_pagamento` inclui `"numerário"` (`schema.ts:85`, `quotas.tsx:640`). Seed com numerário. Sem `cash_status`, `verification_method`, evidência fotográfica, registante ≠ verificador, prazo 5 dias úteis. `PATCH /pagar` com `metodoPagamento` livre liquida a obligation (`pago: true`).

**Fatia:** F2; Role `Fiscalizacao` tem de existir desde F0 (G-001).

#### G-019 — `BankConnection` não é o ciclo de vida LUMEN  
**Severidade:** major  
**LUMEN:** ADR-014; F2 BankConnection na **conta do condomínio**.  
**Código:** `schema.ts:130-141` `sessionId`, `bankName` default «Santander Empresas PT», `status` active/expired/revoked. Sem `consent_status`, conta do condomínio, `authorized_by` Membership, `reauthorization_required`. OAuth `psu_type: business` (`bank.ts:537`) liga a sessão Enable Banking, não ao modelo de domínio. Uma row `limit(1)`.

**Fatia:** F2; Enable Banking **depois** do Finance Kernel passar testes (`06-FATIAS` sequência 8). **Premature:** sync já corre no boot.

#### G-020 — Recibos/Avisos são documentos-fonte, não `FinancialDocument`  
**Severidade:** major  
**LUMEN:** ADR-015; invariante 13; F3 Essencial «Avisos e Recibos gerados a partir do Ledger».  
**Código:** tabela `recibos` com `quotaId`, PDF, `enviadoEmail`. Geração a partir de quotas `pago`. Sem `generated_from`. Avisos HTML em `avisos_enviados` com dívidas snapshot. Cron dia 1 envia lote (`index.ts:135-157`).

**Fatia:** F2 jobs `GenerateMonthlyPaymentNotices` / Receipts.

#### G-021 — Pagamento parcial impossível; CascataConfig sem SettlementPolicy  
**Severidade:** major  
**LUMEN:** ADR-003, ADR-004; invariante 3.  
**Código:** `pagarQuota` (`identity-matrix.ts:1056-1059`): se `resto < devido` → `"stop"` — **não amortiza parcial**. Preferência de ordem hardcoded (condomínio/FR primeiro). Sem `legal_basis` versionado.

**Fatia:** F2 `SettlementEngine`.

#### G-022 — LLM no match financeiro + confiança numérica  
**Severidade:** major  
**LUMEN:** ADR-007, ADR-025 (confiança qualitativa; analogia). `06-FATIAS` F2: LLM fallback = Payment **candidato** com score, não pago.  
**Código:** `llm-fallback.ts:9` `{ confidence: 87 }`; threshold 80 auto-learn. Pode alimentar `pago: true` via `transfer-match`.

**Fatia:** F2; até lá desligar auto-liquidação por LLM.

---

### 3.4 F3 — Onboarding / portal / PWA

#### G-023 — Sem `Invitation`; onboarding = admin cria user  
**Severidade:** blocker para piloto Essencial  
**LUMEN:** ADR-001, ADR-017; F3; `04-PORTAS`.  
**Código:** `admin-users.ts:22-56` `POST /admin/users` signUpEmail + role. Login copy: «Acesso por convite apenas» (`login.tsx:94`) — **copy sem mecanismo**. Sem token de uso único, verificação de contacto, `lote_id`, pré-visualização fração↔pessoa↔contacto.

**QR físico:** não encontrado como credencial (alinhado por ausência). Não há QR no email de convite porque não há convite.

**Fatia:** F3 após F0 auth Membership. UI F3 pode adiantar-se; **release com saldos exige F2**.

#### G-024 — Portal Essencial viola o contrato  
**Severidade:** blocker para piloto  
**LUMEN:** F3 tabela Essencial; ADR-035 lista móvel **sem votação até F5**; Actas só `PUBLISHED`.  
**Código:** `portal.ts` saldo = `Quota.pago`.  
`portal.tsx:309` `submitAtaVote`; status `aguardando_votos`; áudio durante votação (`canPlay={ata.status === "aguardando_votos"}`).  
`atas.ts:353` visível ao condómino: `aprovada | rejeitada | aguardando_votos` — **não** `PUBLISHED`.

**Fatia:** F3 portal depois de F2; **retirar voto do critério piloto** (não precisa apagar código agora — flag premature).

#### G-025 — Sem PWA / Sevilla / spike iOS push  
**Severidade:** major (piloto tolera fricção; comercial não)  
**LUMEN:** `04-PORTAS` Directriz Sevilla `#FFFFFF` / `#F5F5F7` / `#D0021B`; F3 PWA + spike iOS.  
**Código:** grep `serviceWorker|manifest|PWA` → 0.  
`styles.css:4-22` — fundo `#0a0c10`, `--blue-primary: #2563eb`, `--red: #ef4444`.  
`Layout.tsx:94` gradient blue/purple.

**Fatia:** F3 polish **depois** do kernel; não nesta semana.

---

### 3.5 F4 — Premature (flag; não reescrever)

#### G-026 — Tickets + triagem LLM antes de F0  
**Severidade:** minor–major (premature; órgão transplantável)  
**LUMEN:** F4 tickets; `06-FATIAS` «não implementar F4/F5/F6 em paralelo com F0/F1». Prioridade determinística, LLM não decide sozinho (`02-DOMINIO` Ticket).  
**Código:** `tickets` + anexos foto/vídeo (`schema.ts:585+`). `triarPedidoTicket`. Auth por `user.role`/`fracaoId`. Email `send-email`. Útil para piloto **depois** de Membership.

**Fatia:** não expandir; transplantar para Domain Service quando F0 existir.

#### G-027 — Reuniões admin + RecordingSegment (alinhado ADR-042, premature vs F0)  
**Severidade:** minor (premature) / **aligned** no recorte Fonte  
**LUMEN:** ADR-042; F4 continuidade MediaRecorder; F0 deve hospedar jobs STT.  
**Código (alinhado):** `recording_segments` UNIQUE `(reuniao_id, ordinal)`; `reason_ended`; `findReuniaoForCurrentTenant`; `end-meeting` idempotente; IDB + resumable upload; testes dedicados; docs `packages/web/docs/REUNIAO-RECORDING-SEGMENTS.md`.  
**Desvios:** estados persistidos `em_curso|processando_audio|rascunho|aprovada` ≠ LUMEN `DRAFT|IN_PROGRESS|ENDED` (ADR-042 emenda Fonte — aceite como implementação, **não** como máquina de Assembleia). STT/LLM **no pedido HTTP** (`reunioes.ts:430-431`). Áudio admin: `reunioes.ts:691-693` unlink no delete; **não** há job «eliminar após resumo» (invariante 9). `audio_path` legado ainda usado.

**Fatia:** não reabrir ADR-042; migrar STT para job F0-C; retenção DPO (gate).

#### G-028 — Sem `Contract` / `AuthorityRule` / `Approval`  
**Severidade:** minor (F4 não é piloto)  
**LUMEN:** ADR-020–027.  
**Código:** `fornecedores` simples; sem Decision Brief versionado, sem invalidação de aprovação.

---

### 3.6 F5 — Premature + contradiz governação

#### G-029 — `atas` não é a máquina de estados v6.1 e não liga a `Reuniao`  
**Severidade:** blocker para comercial / major agora (não é critério piloto)  
**LUMEN:** ADR-034; invariante 21–23, 32; 1 Acta por Reunião; STT consome segmentos.  
**Código:** `schema.ts:418-443` status `rascunho | processando_audio | erro_audio | em_revisao | pdf_definitiva | aguardando_votos | aprovada | rejeitada`. **Sem `reuniao_id`.** Pipeline de áudio de ata é **paralelo** ao de `reunioes` (`atas.ts` upload+STT próprio).  
`PATCH /:id/aprovar` `requireAdmin` (`atas.ts:538`) — admin aprova.  
`tryAutoCloseVoting` (`atas.ts:91-145`): threshold default **50% da permilagem total** (`configuracoes.ts:28-30`) — viola ADR-005 / invariante 5 (*nunca % universal hardcoded*).  
Voto `approve|reject` na **ata inteira**, não `Deliberacao` + snapshot `Voto`/`Participante`. Sem `hash_aprovada`/`hash_final`. Sem assinatura vs subscrição. Sem `PUBLISHED`.

**Fatia:** F5 **depois** de F0–F3 piloto. Não «melhorar %» agora.

#### G-030 — Votação no portal antes de F5 «live» e sem step-up  
**Severidade:** major (produto + ADR-035)  
**LUMEN:** votação só com F5; step-up; piloto sem voto como critério.  
**Código:** `POST /atas/:id/votes` (`atas.ts:667`); portal UI. Voto ligado a `userId` live, não snapshot. Admin também pode votar (`atas.ts:680-682`).

#### G-031 — Sem convocatória por Membership / `ConvocationDispatch`  
**Severidade:** major (F5; legal)  
**LUMEN:** ADR-041; invariante 30; `unknown` → HUMAN REVIEW nunca AUTO SEND.  
**Código:** inexistente. Emails de avisos de quota ≠ convocatória art. 1432.º.

#### G-032 — Áudio de assembleia: janela de voto, não hard-delete pós-`APPROVED`  
**Severidade:** major (privacy gate)  
**LUMEN:** ADR-011; invariante 9; todos os `RecordingSegment` após `Acta.APPROVED`; stuck → retry+alerta.  
**Código:** `atas.audioAvailableUntil`; delete em `tryAutoCloseVoting` quando passa a `aprovada|rejeitada` (`atas.ts:125-139`) — **um** `audioPath`, não segmentos. Sem job observável. DPO não confirmado (`PRODUCTION-GATES`).

---

### 3.7 F6 — Premature

#### G-033 — LLM espalhado sem Maestro / validação em camadas  
**Severidade:** major (scope freeze)  
**LUMEN:** `03-ORQUESTRA` *«Não implementar antes de existirem tenant + ingestão»*; ADR-008 Risk Engine **não** aprova Actas.  
**Código:** `llm.ts`, `llm-fallback.ts`, `ticket-llm.ts`, `email-llm.ts`, `atas-llm.ts`, `reuniao-llm.ts`, `email-ticket-pipeline.ts`. Sem especialistas, sem KB `mandatory|default|configurable|unknown`.

**Fatia:** freeze F6 até F4/F5 estáveis (`06-FATIAS` diagrama).

---

### 3.8 Legacy building-ops / docs drift

#### G-034 — Fail-open API + jobs no processo web  
**Severidade:** blocker (ops/security)  
**LUMEN:** F0 critérios 1, 9, 10; ADR-038.  
**Código:** ver G-007, G-004. `index.ts` health `app: "Gestão Condomínio"`. README/ARCHITECTURE descrevem roles admin/condómino e Fonte como produto.

#### G-035 — `pagador_perfis` «cross-condomínio» numa BD única  
**Severidade:** minor–major  
**LUMEN:** isolamento por tenant; invariante 1.  
**Código:** `schema.ts:214` comentário «aprendizagem cross-condomínio»; `pagador-perfis.ts:2` «multi-condomínio ready» mas tabela no mesmo SQLite que as frações Fonte.

#### G-036 — Docs de produto (não-lumen) no modelo antigo  
**Severidade:** minor (docs drift)  
**LUMEN:** pacote v6.1 é canónico.  
**Código:** `README.md` (2026-08-12) «roles admin/condómino»; `docs/ARCHITECTURE.md` (2026-08-22) «Auth better-auth (admin / condómino)», condomínio piloto Fonte; `packages/web/docs/REUNIAO-RECORDING-SEGMENTS.md` correcto para ADR-042 mas afirma isolamento 1 BD/tenant **nesta** app via coluna — defesa em profundidade, não o ADR-016 completo.

#### G-037 — Design e naming «Gestão de Condomínio» / BuildingMind token  
**Severidade:** minor  
**Código:** `web/lib/auth.ts:3` `TOKEN_KEY = "bm_token"`; `styles.css` dark+blue. LUMEN marca + Sevilla em `04-PORTAS`.

#### G-038 — Sem Tenant Exit / portabilidade  
**Severidade:** minor agora (arquitectural ADR-037)  
**Código:** sem export estruturado. Desenho actual (flags, âncoras, JSON em movimentos) **dificulta** a exportação futura — risco a não piorar em F2.

#### G-039 — Cron de fecho de mês ≠ `AccountingPeriod`  
**Severidade:** major (F2)  
**LUMEN:** invariante 8 — fecho nunca bloqueia; posted/pending/adjustments visíveis.  
**Código:** `index.ts:81-168` gera PDFs e emails. Sem os três blocos. Relatório mistura totais.

#### G-040 — Permilagem como `%` no schema  
**Severidade:** minor  
**Código:** `schema.ts:22` comentário `// % do edifício` vs LUMEN ‰ e invariante 1 Σ=1000‰. Seeds usam ‰ (38.80, etc.) — comentário drift.

---

## 4. File inventory (misaligned)

Ficheiros de produto relevantes que **não** estão alinhados com v6.1 (exceto ruído). «Papel» = categoria do gap.

| Ficheiro | Papel | Gaps |
|---|---|---|
| `packages/web/src/api/database/schema.ts` | schema | G-001, G-005, G-014–G-020, G-023, G-029, G-035, G-040 |
| `packages/web/src/api/database/auth-schema.ts` | identidade | G-001 |
| `packages/web/src/api/auth.ts` | auth | G-001, G-007 |
| `packages/web/src/api/middleware/auth.ts` | auth | G-001, G-007 |
| `packages/web/src/api/database/index.ts` | tenant | G-002 |
| `packages/web/src/api/lib/tenant.ts` | tenant | G-002 (parcial, só reunioes) |
| `packages/web/src/api/lib/condominio.ts` | Fonte | G-013 |
| `packages/web/src/api/index.ts` | jobs / rotas | G-004, G-007, G-034, G-039 |
| `packages/web/src/api/lib/idempotency.ts` | jobs | G-004 (HTTP-only) |
| `packages/web/src/api/lib/reuniao-audit.ts` | audit | G-005 |
| `packages/web/src/api/lib/identity-matrix.ts` | finance | G-008, G-013–G-016, G-021 |
| `packages/web/src/api/lib/llm-fallback.ts` | F2/F6 | G-008, G-022, G-033 |
| `packages/web/src/api/lib/transfer-match.ts` | finance | G-014, G-015 |
| `packages/web/src/api/lib/cartas-julho-2026.ts` | finance | G-013, G-016 |
| `packages/web/src/api/lib/pagador-perfis.ts` | finance | G-035 |
| `packages/web/src/api/lib/reconciliation-engine.ts` | finance | G-014, G-013 (montantes Fonte) |
| `packages/web/src/api/lib/rateio.ts` | finance | legado rateio ≠ Obligation |
| `packages/web/src/api/lib/ticket-email.ts` | notify | G-009 |
| `packages/web/src/api/lib/ticket-llm.ts` | F4/F6 | G-026, G-033 |
| `packages/web/src/api/lib/email-llm.ts` | F6 | G-033 |
| `packages/web/src/api/lib/email-ticket-pipeline.ts` | F4 | G-026; filtra `user.role === "admin"` |
| `packages/web/src/api/lib/atas-llm.ts` | F5/F6 | G-029, G-033 |
| `packages/web/src/api/lib/reuniao-llm.ts` | F4/F6 | G-027, G-033 |
| `packages/web/src/api/lib/stt.ts` | F4/F5 | G-004 (HTTP); órgão transplantável |
| `packages/web/src/api/routes/quotas.ts` | finance | G-003, G-007, G-014, G-018 |
| `packages/web/src/api/routes/fracoes.ts` | constituição | G-007, G-012 |
| `packages/web/src/api/routes/dashboard.ts` | finance UI API | G-007, G-016, G-013 |
| `packages/web/src/api/routes/configuracoes.ts` | config | G-007, G-016, G-029 (50%) |
| `packages/web/src/api/routes/portal.ts` | F3 | G-014, G-024 |
| `packages/web/src/api/routes/admin-users.ts` | identidade | G-001, G-023 |
| `packages/web/src/api/routes/setup.ts` | identidade | G-001 |
| `packages/web/src/api/routes/seed.ts` | Fonte | G-007, G-013, G-015 |
| `packages/web/src/api/routes/import.ts` | F1/F2 | G-011, G-015 |
| `packages/web/src/api/routes/bank.ts` | F2 premature | G-004, G-019 |
| `packages/web/src/api/routes/bank-movements.ts` | F2 | G-014, G-015 |
| `packages/web/src/api/routes/recibos.ts` | F2 | G-009, G-020, G-017 (hash) |
| `packages/web/src/api/routes/avisos.ts` | F2 | G-009, G-020 |
| `packages/web/src/api/routes/relatorio.ts` | F2 | G-014, G-039 |
| `packages/web/src/api/routes/cativo-rules.ts` | F2 | gavetas ≠ Ledger |
| `packages/web/src/api/routes/atas.ts` | F5 | G-029, G-030, G-032 |
| `packages/web/src/api/routes/reunioes.ts` | F4 | G-004, G-027 (STT HTTP) |
| `packages/web/src/api/routes/tickets.ts` | F4 | G-026 |
| `packages/web/src/api/routes/email-inbox.ts` | F4/F6 | G-013, G-033, G-004 (setInterval) |
| `packages/web/src/api/routes/uploads.ts` | F0/F4 | parcial; admin-only |
| `packages/web/src/api/routes/identity.ts` | finance | expõe matriz em memória |
| `packages/web/src/web/app.tsx` | rotas UI | G-024, G-025 (sem convite/PWA) |
| `packages/web/src/web/lib/auth.ts` | auth UI | G-001, G-037 |
| `packages/web/src/web/components/ProtectedRoute.tsx` | auth/jobs | G-001, G-004 |
| `packages/web/src/web/components/Layout.tsx` | UI | G-025 |
| `packages/web/src/web/styles.css` | design | G-025 |
| `packages/web/src/web/pages/portal.tsx` | F3/F5 | G-024, G-030 |
| `packages/web/src/web/pages/login.tsx` | F3 | G-023 |
| `packages/web/src/web/pages/utilizadores.tsx` | identidade | G-001, G-023 |
| `packages/web/src/web/pages/quotas.tsx` | F2 | G-014, G-018 |
| `packages/web/src/web/pages/quota-tipos.tsx` | F2 | G-015 |
| `packages/web/src/web/pages/atas.tsx` | F5 | G-029 |
| `packages/web/src/web/pages/index.tsx` | dashboard | G-016, G-013 |
| `packages/web/src/web/pages/definicoes.tsx` | config | G-016 |
| `packages/web/src/web/pages/importar.tsx` | F1 | G-011 |
| `packages/web/src/api/database/seed-*.ts` | Fonte | G-013 |
| `packages/web/scripts/import-excel-2026.ts` | Fonte | G-013, G-015 |
| `packages/web/scripts/setup-local-db.ts` | schema local | replica `pago`/`fundo_reserva` |
| `README.md` / `docs/ARCHITECTURE.md` | docs drift | G-036 |
| `packages/web/src/api/lib/reuniao-recording.ts` + testes | ADR-042 | **alinhado** no recorte; premature F0 jobs |

**Alinhados ou aceites como Fonte+ADR-042 (não listar como «apagar»):**  
`recording_segments` schema, `reuniao-ordinal.ts`, `reuniao-access.ts`, `recording-idb.ts`, `resumable-upload.ts`, `RecordingContext.tsx`, `RecordingBar.tsx`, migration `0001_reuniao_recording_segments.sql`, `packages/web/docs/REUNIAO-RECORDING-SEGMENTS.md`.

**Pacotes:** só `packages/web` está activo. `_archive/mobile` e `_archive/desktop` fora do `dev` — não auditar como LUMEN.

---

## 5. Backlog ordenado (1–2 semanas, WIP ≤ 2 frentes F0)

Prioridade LUMEN: **Domain Kernel antes de expandir F4/F5.** Não começar Finance Kernel. Não «consertar» atas/voto. Não ligar mais Groq.

### Semana 1–2 — no máximo duas frentes

**Frente A — Domain Kernel v0.1 (obrigatória)**  
1. Schema (na BD de tenant, ainda pode ser a BD Fonte): `Person`, `Membership`, `Role` seed (`Owner`, `CoOwner`, `Proxy`, `Admin`, `PlatformAdmin`, `Fiscalizacao`), `Scope` opcional nullable.  
2. Completar `AuditEvent` (before/after/reason/source/request_id) e emitir na **primeira** mutation (criar Membership / revogar).  
3. Esqueleto `application/` + `domain/` + `infra/repos` — um use case `CreateMembership` chamado pela rota; **não** migrar `dashboard.ts`.  
4. Testes: Membership revogada → 403; request sem tenant/membership → 403 no novo middleware (mesmo com 1 tenant).  
5. Mapear `user` better-auth → `Person` (sessão identifica pessoa; autorização lê Membership). Deixar `user.role` legado atrás de um adapter **temporário**, sem novas features em cima.

**Frente B — escolher uma (não as duas extra):**  
- **B1 TenantDirectory** (plataforma): tabela/registo fora do tenant (`tenant_id`, `db_ref`, `schema_version`, `status`, `backup_status`). Provisionamento idempotente de **um** segundo DB de teste. **ou**  
- **B2 Outbox/Jobs mínimos:** tabela outbox + worker; migrar **um** efeito (ex. audit persistente ou STT de reunião, já documentado ADR-042) para job idempotente. **Não** migrar bank sync completo nesta janela.

**Congelar explicitamente (decisão de capacidade, não apagar código):**  
- Novas features de atas/voto/convocatória.  
- Novos campos `Quota.pago` / novas regras de cascata / mais âncoras.  
- Novos especialistas LLM / inbox / «Orquestra».  
- Enable Banking «melhorias» (reauth UI ok se for bug Fonte; não o modelo BankConnection).  
- PWA/Sevilla (F3 polish).  
- Invitation (F3) — **fila**, depende de Frente A.

### Imediatamente a seguir (semana 3+, não agora)

6. Object storage + pipeline upload ≠ processamento (F0 item 5) → vertical slice F1 (regulamento, linha a linha).  
7. Invitation + verificação de contacto (F3) **sem** prometer saldo Ledger.  
8. Finance Kernel F2 **só** com F0 propriedades 1–4 e 9–10 verdes e F1 a passar.

### O que **não** fazer nesta janela

- Reescrever `identity-matrix` / dashboard como Ledger.  
- Inventar % de aprovação de acta.  
- Criar entidade `ConselhoFiscal`.  
- QR.  
- F6 Maestro.  
- Tratar RecordingSegment como «F0 feito».

---

## 6. Método e limites desta auditoria

- Pacote lido: `00-INDICE`, `ADR-LOG` (001–042), `01`–`06`, `PRODUCTION-GATES`, `AUDITORIA-V61`, `AUDITORIA-COMPLEMENTAR-V61`, diagramas (amostra), `07` (Fonte vs LUMEN).  
- Inventário: `packages/web/src/api/**`, `packages/web/src/web/**`, schema Drizzle, testes, scripts de seed/import.  
- Não se executou a app nem se validaram gates legais com advogado/DPO (são FAIL por ausência de evidência, não por ensaio).  
- Hunches anteriores: o enxerto RecordingSegment **confirma-se** alinhado a ADR-042 no recorte reuniões admin; **não** substitui F0. O resto da app é Fonte pré-kernel.

---

## 7. Veredicto final (piloto vs F0–F3 Essencial)

| Capacidade Essencial (piloto) | Estado |
|---|---|
| Convite (`Invitation`) | Ausente |
| Conta / sessão → Membership | Ausente (`user.role`) |
| Saldo e dívidas via Ledger | Contradiz (`Quota.pago`) |
| Avisos/Recibos `FinancialDocument` | Recibos/avisos Fonte, não reconstruíveis do Ledger |
| Ticket + foto | Existe (premature F4; órgão útil) |
| Contactar admin | Parcial (tickets/email inbox Fonte) |
| Documentos financeiros download | Recibos PDF existem; verdade invertida |
| Consulta Actas só `PUBLISHED` | Contradiz (voto + estados Fonte) |
| **Votação** | Presente — **não deveria ser critério**; aqui é risco |

**Pilot launch = NO-GO.**  
**Próximo movimento canónico = Frente A Domain Kernel + no máximo Frente B1 ou B2.**
