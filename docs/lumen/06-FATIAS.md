# 06 — Fatias de Entrega (F0–F6)

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Cada fatia é entregável e testável independentemente. Nenhuma fatia posterior deve bloquear a anterior.
>
> **Nota complementar (v6.1):** F5 inclui convocatória multi-canal (art. 1432.º) e gravação multi-segmento; continuidade MediaRecorder também em F4 (reuniões admin).
>
> Precedência em caso de conflito: ADR-LOG > 02-DOMINIO > 06-FATIAS > diagramas > resto (ver `00-INDICE.md`).
> Gates de produção: [PRODUCTION-GATES.md](PRODUCTION-GATES.md).

---

## Modelo de lançamento — Opção A

Dois limiares distintos. Não confundir piloto com comercial geral.

### Pilot launch (lançamento piloto)

Âmbito: F0–F3 com capacidades Essencial:

| Capacidade Essencial | Notas |
|---|---|
| Convite (`Invitation`) | Individual ou em lote, com confirmação admin |
| Conta / sessão | Aceitar convite → criar/associar conta → `Membership` |
| Saldo e dívidas | Sempre a partir do Ledger (F2), nunca de cache |
| Avisos de Débito e Recibos | `FinancialDocument` gerados a partir do Ledger |
| Ticket + foto | Operação mínima do condómino |
| Contactar admin | Canal de suporte no portal |
| Documentos financeiros | Download de avisos/recibos/extrato |
| Consulta de Actas | **Só se existirem Actas em estado `PUBLISHED`** — não obriga fluxo de votação |

**Votação não é critério do piloto.** Pode existir mais tarde (F5); o piloto Essencial fecha sem ela.

### General commercial launch (lançamento comercial geral)

Exige F5 (votação digital + fluxo completo de Acta) e cumprimento dos [Production Readiness Gates](PRODUCTION-GATES.md).

Dinheiro real em escala, ops de produção e decisões legais vinculativas via produto = NO-GO até aos gates (ver `00-INDICE.md`).

---

## Ordem real de execução (Vertical Slice, não horizontal)

A documentação descreve o domínio na horizontal. A implementação segue fatia vertical:

```
Criar condomínio → admin autentica-se → ingerir documento →
extrair frações → mostrar origem (excerto do PDF) → admin confirma
linha a linha → persistir Person/Membership/Fracao → AuditEvent
```

**Sequência recomendada:**

1. Congelar Domain Kernel v0.1 — sem inventar mais entidades: `Tenant`, `Person`, `Membership`, `Fracao`, `Role`/`Scope` (incl. `Fiscalizacao`), `AuditEvent`, Events/Jobs mínimos
2. `TenantDirectory` + provisionamento idempotente de 1 DB Turso por condomínio
3. Auth + autorização real — sessão → pessoa; `Membership` → tenant/role; `tenant_id` sozinho nunca autoriza
4. `AuditEvent` desde a primeira mutation
5. Object storage + pipeline de ingestão (upload ≠ processamento)
6. Primeiro vertical slice de F1
7. Finance Kernel (F2)
8. Enable Banking só depois do Finance Kernel passar testes adversariais
9. Onboarding dos condóminos (F3) → **piloto Essencial** quando F0–F3 Essencial estiver estável
10. F4/F5/F6 como especificações maduras — **não implementar em paralelo com F0/F1**; F5 + gates → comercial geral

---

## Visão Geral

```
F0  Plataforma + Domain Kernel  ████░░░░░░░░░░░░░░░░░░░░░░░░░░
F1  Ingestão + Constituição     ░░░░████░░░░░░░░░░░░░░░░░░░░░░
F2  Financeiro (Ledger)         ░░░░░░░░████░░░░░░░░░░░░░░░░░░
F3  Onboarding + PWA (Essencial)░░░░░░░░░░░░████░░░░░░░░░░░░░░  ← piloto
F4  Operações + Orçamentos      ░░░░░░░░░░░░░░░░████░░░░░░░░░░
F5  Assembleia / Governança     ░░░░░░░░░░░░░░░░░░░░████░░░░░░  ← comercial (+ gates)
F6  Orquestra LLM               ░░░░░░░░░░░░░░░░░░░░░░░░████░░
```

---

## F0 — Plataforma + Domain Kernel

**Objectivo:** 1 BD por condomínio, identidade extensível, eventos/auditoria/políticas/notificações desde o início — para não refatorar F1–F5 quando a Orquestra (F6) chegar.

| Item | Detalhe |
|------|---------|
| Multi-tenant | 1 Turso DB por condomínio (Turso Platform API) |
| Estratégia de conexão | Cliente stateless via API HTTP Turso/libSQL + cache LRU dos clientes de tenants ativos |
| **TenantDirectory** | Registo central fora das BDs de tenant: provisionamento, schema/migrations, backup, restore-test, secrets, alertas — requisito F0, não melhoria futura |
| Identidade (Domain Kernel) | `Person` + `Membership` (`Role` + `Scope` opcional). Bootstrap de roles: **Owner / CoOwner / Proxy / Admin / PlatformAdmin / Fiscalizacao** |
| Auth | better-auth; sessão ligada ao `Membership`, não a um `user.role` plano |
| API base | Hono com middleware tenant-aware |
| Domain Services | Rotas Hono → Use Cases / Application Services → Domain Services → Repositories — nunca SQL/Drizzle nas rotas |
| Domain Events | Bus `DomainEvent` em toda mudança de estado relevante |
| Job Queue | Outbox + idempotência desde o início (convites, emails, OCR, bank sync, PDFs, IA) |
| Audit Log | `AuditEvent` (who/what/when/before/after/reason/source) — entidade operacional, não “logging” |
| Policy Engine (esqueleto) | Aloja depois `SettlementPolicy` (F2), `ResolutionRule` (F5), `AuthorityRule` (F4) |
| **Notificações (cross-cutting)** | Email = canal primário desde F0, com envio / retry / estado de entrega / observabilidade. **Não** promete “entrega garantida na caixa de entrada do utilizador”. Push em F3, best-effort |
| **Independência de LLM** | Rotas de finanças/governação (saldo, dívida, documentos, voto quando existir) não podem depender de LLM no caminho crítico |
| Deploy | Fly.io / Railway; BD em Turso |
| PWA shell | Branco puro / cinza ultra-leve + vermelho Sevilha — ver Diretiva de Design em `04-PORTAS.md` |

**Critério de conclusão (propriedades testáveis):**

1. Tenant A nunca consulta, altera ou provoca jobs no Tenant B
2. `Membership` revogada perde autorização de imediato — sessão ativa não sobrevive à revogação
3. Toda mutation relevante produz `AuditEvent`
4. Job duplicado (retry) não produz efeito duplicado (idempotência real)
5. Upload repetido do mesmo ficheiro não corrompe estado
6. Migration de schema: N tenants de vX → vX+1 com falhas reportadas individualmente
7. Backup e restore de um tenant testados de verdade
8. Secrets e credenciais bancárias nunca entram em logs
9. Request sem tenant válido falha fechado (403)
10. **Efeitos externos assíncronos críticos são idempotentes e observáveis** — email, convites, notificações, geração de PDFs, bank sync: estado explícito, retries, chave de idempotência, correlação, e registo em `AuditEvent` / `DomainEvent`. Sem “fire-and-forget” opaco

Só com estas propriedades demonstradas — não “admin cria tenant e vê dashboard vazio” — F0 está concluído.

---

## F1 — Ingestão + Constituição

**Objectivo:** admin configura um condomínio completo a partir de PDFs, fotos e CSV.

| Item | Detalhe |
|------|---------|
| Upload Regulamento PDF/foto | Armazenamento + extracção LLM de permilagens/regras |
| Frações automáticas | A partir das permilagens extraídas |
| Contactos proprietários | PDF/Excel/foto ou manual — necessários para Convite em F3 |
| Comprovativo IBAN | PDF ou foto das contas do condomínio — retenção **diferenciada** (documento pessoal vs. legal; ver ADR-030 e `04-PORTAS.md`) |
| Orçamento anual | Por rubrica (Quota corrente, FCR, Extraordinária) → `Obligation`s |
| Confirmação | Admin revê linha a linha; pode editar depois (venda de fração, novo condómino) |

**Critério:** admin sobe PDF/Excel/foto, confirma **linha a linha** (excerto de origem visível), frações existem com `Obligation`s calculadas.

**GO:** após freeze v6.1, em paralelo conceptual com F0 só como vertical slice — não substituir o Domain Kernel.

**Estado de código:** ver [F1-IMPLEMENTACAO.md](F1-IMPLEMENTACAO.md) — vertical slice no kernel (extração estruturada + confirmação + obligations); LLM/OCR real e UI ficam para iteração seguinte.

---

## F2 — Financeiro (Ledger)

**Objectivo:** Obligation / Payment / Allocation / Ledger / SettlementPolicy / AccountingPeriod — não `Quota.pago: boolean` nem retenção % de FCR.

| Item | Transplante (dev) | Adaptação |
|------|-------------------|-----------|
| Obligations | Novo | A partir do orçamento (F1): Quota corrente, FCR (≥10% da quota-parte nas despesas, DL 268/94 art. 4.º — nunca % sobre pagamento), Extraordinária. **Nunca** criadas por algoritmo solto |
| BankConnection Lifecycle | Novo | Conta do **condomínio**, nunca da pessoa do admin; consent_status, reautorização, last_sync / last_error |
| Reconciliação banco | `reconciliation-engine.ts` | Por tenant; resultado = `Payment` candidato, nunca “pago” direto |
| CSV import | `csv-bank-parser.ts` | Multi-banco — fallback quando BankConnection em reautorização |
| Match de identidade | `identity-matrix.ts` | Liga `Payment` a `Fracao`; não decide alocação sozinho |
| Allocation Engine | Novo | `SettlementPolicy` vigente; Ledger append-only **com hash-chain** |
| Pagamento em dinheiro | Novo | Ver tabela abaixo |
| SettlementPolicy | Novo | Versionada, `legal_basis[]` |
| LLM fallback match | `llm-fallback.ts` | Sempre `Payment` candidato com score de confiança |
| Job `GenerateMonthlyPaymentNotices` | Novo | Dia 1: `FinancialDocument` tipo `PaymentNotice` |
| Job `GenerateMonthlyReceipts` | Novo | Ao confirmar `Payment` (+ sweep de fecho); nunca recibo vazio |
| Account Statement | Novo | `FinancialDocument` tipo `AccountStatement` sob pedido |
| Fecho de mês | `routes/relatorio.ts` | `AccountingPeriod`: posted / pending / adjustments_after_close |
| Morosos | dashboard + alertas | Via `Obligation.valor_em_aberto` |

### Dinheiro (`cash`) — estados e verificação

| Campo | Valores | Regra |
|---|---|---|
| `cash_status` | `registered` → `verified` → `deposited` | Três estados distintos; nunca um único “recebido” |
| `verification_method` | `second_person` \| `bank_deposit` | Como se passou de `registered` a `verified` |

- **Admin não se auto-confirma:** quem regista ≠ quem verifica (`Fiscalizacao` / segunda pessoa), salvo caminho `bank_deposit`
- **Prazo de depósito:** configurável por tenant; **default documentado = 5 dias úteis** (ajustar só com decisão explícita + AuditEvent)
- **Evidência fotográfica** do recibo físico obrigatória
- **`Obligation` nunca fica liquidada só com `cash_status = registered`**
- Em `deposited`, existe `MovimentoBancario` reconciliado
- Toda alocação no Ledger entra na **hash-chain** (ADR-029)

**Critério:** sync bancário (ou aviso proactivo de reautorização), `Payment`s candidatos, Allocation + hash-chain, dinheiro com os 3 estados, avisos dia 1, recibos na confirmação, documentos rastreáveis via `generated_from`.

**GO:** só depois do Domain Kernel (F0) congelado e do vertical slice F1 a passar.

---

## F3 — Onboarding por Convite + PWA (Essencial do piloto)

**Objectivo:** condómino entra por convite individual, privado e revogável — **nunca por QR físico** (ADR-001).

| Item | Detalhe |
|------|---------|
| Invitation | Por fração + contacto; uso único, revogável, expira; individual ou lote (`lote_id`) |
| Ativação da Comunidade | Pré-visualização fração ↔ pessoa ↔ contacto → “Enviar N Convites”. **Nunca** envio automático a partir de OCR |
| Painel de ativação | Convidados / contas / portal aberto / documentos vistos |
| **Verificação de contacto** | Destinatário confirma o contacto (código/link) antes de criar/associar conta. **Não é verificação de identidade / KYC** — KYC verdadeiro = Future Decision / fora do MVP. O admin valida Person ↔ Fraction ↔ Membership |
| Membership | Na aceitação: `Person` + `Fracao` + `Role` |
| Portal Essencial | Saldo (Ledger), avisos/recibos/extrato, tickets+foto, contactar admin, documentos financeiros; Actas só se `PUBLISHED` |
| PWA | Service worker, offline shell, install prompt |
| Design | Sevilla — ver `04-PORTAS.md` |
| Step-up | Ações sensíveis (alterar IBAN, titular; votar **quando F5 existir**) |
| Sem QR físico | QR residual só dentro do email/SMS de um convite já emitido |
| **Kit de assembleia (ordem do dia / briefing)** | Artefacto leve para reduzir fricção de venda no piloto — **não é CRM** |
| **Spike iOS push** | Validar push PWA no iOS Safari (16.4+, “Adicionar ao ecrã principal”) **antes de fechar F3**. Se frágil, email continua primário; push best-effort |
| **Regra de capacidade** | Sem distribuição além do piloto enquanto F0–F2 não estiverem estáveis |
| Release | UI F3 pode avançar em paralelo; **release** do portal com saldos exige F2 fiável |

**Critério do piloto:** convites em lote, verificação de contacto, Membership, saldo real + documentos F2, ticket+foto, contactar admin — testado em iOS Safari + Android Chrome com utilizadores não-técnicos. **Sem votação como critério.**

---

## F4 — Operações + Orçamentos + Contratos (leve)

**Objectivo:** tickets com foto, orçamentos com cotações, contratos com lembrete, reuniões admin — decisões comprimidas, não trabalho bruto.

| Item | Detalhe / transplante |
|------|------------------------|
| Tickets | Criar com foto; categorização LLM; prioridade por heurística. Transplante: fluxos de tickets da `dev` |
| Orçamentos | `criterios_pesos` + `confianca_recomendação` qualitativa |
| Cotações | 3 fornecedores conhecidos + 2 do mercado |
| SLA | 4h urgente, 48h normal |
| Decision Brief | Formato fixo; “melhor valor”, rastreável |
| AuthorityRule | Quem pode autorizar *esta* ação neste contexto |
| Approval | Snapshot da versão aprovada; alteração material invalida (ADR-027) |
| Contract (leve) | Renovação + aviso prévio; sem procurement autónomo (Tier 3) |
| Centro de Operações | Decisões/exceções, não navegação por objetos |
| Reuniões Admin | Whisper/STT da `dev` possível; resumo informativo; áudio eliminado após resumo (RGPD). **Continuidade de gravação** (`RecordingSegment` / mesma sessão face a interrupção técnica) onde existir MediaRecorder — mesmo princípio que F5 (ADR-042). MVP: IDB+upload resumível no cliente; STT ainda no pedido HTTP até job F0 |

**Critério:** ticket com prioridade; Decision Brief; Approval versionada; lembrete de contrato; reunião resumida com áudio purgado.

**Capacidade:** features “nice” de F4–F6 ficam em freeze até **10 tenants pagos** ou fim do piloto (ver secção Capacidade).

---

## F5 — Assembleia / Governança

**Objectivo:** reuniões, transcrição, atas, votação digital — quórum/maioria via `ResolutionRule`, não hardcoded.

| Item | Transplante (dev) | Detalhe |
|------|-------------------|---------|
| Áudio → texto | `stt.ts` (Whisper chunk 25MB) | Overlap ~30s + timestamps de diarização; consome `RecordingSegment` por ordinal |
| Gravação multi-segmento | Novo (sobre MediaRecorder) | `Reuniao` contínua: `DRAFT → IN_PROGRESS → ENDED`; segmentos com `reason_ended`; falha técnica ≠ fim da reunião (ADR-042) |
| Acta automática | `atas-llm.ts` + helpers | LLM a partir da transcrição; **uma Acta por Reuniao** |
| ResolutionRule | Novo | Seed art. 1432.º; regulamento pode ser mais exigente |
| Votação digital | `routes/atas.ts` | Por fração, ponderada; step-up |
| Convocatória multi-canal | Novo | Meio por `Membership` (`registered_mail` / `authorized_email` / …); `ConvocationDispatch`; `unknown` → HUMAN REVIEW, nunca AUTO SEND (ADR-041) |
| DeliberationNotice | Novo | Comunicação aos ausentes (art. 1432.º n.º 9) — **separada** da convocatória |
| Deliberações | Novo | Eficazes a partir da **aprovação** da Acta (DL 268/94 art. 1.º n.º 3), independentemente de assinatura |
| Fluxo Acta (estados) | Novo | Ver máquina de estados abaixo |
| Voto remoto (futuro) | Novo | Só com assinatura oficial (CMD / CC) |
| Retenção áudio | Novo | Hard-delete de **todos** os segmentos após aprovação; prazo com DPO/advogado antes de produção |

### Estados da Acta (v6.1)

```
DRAFT
  → SUBMITTED_FOR_APPROVAL
  → APPROVAL_IN_PROGRESS
  → APPROVED
  → PRINT_READY
  → SIGNATURES_PENDING
  → DOCUMENT_SUBMITTED
  → FINAL
  → PUBLISHED
```

- Presidente **assina**; presentes **subscrevem** individualmente (manuscrita / eletrónica qualificada / declaração eletrónica) — nunca “só a mesa assina”
- `hash_aprovada` ≠ `hash_final_subscrita`
- OCR compara estrutura; **nunca** valida assinaturas juridicamente
- Consulta no portal piloto/comercial: só Actas `PUBLISHED` (ou equivalente explícito de publicação)
- Validar com advogado de propriedade horizontal antes de produção (ADR-034)

**Critério:** áudio multi-segmento → transcrição ordenada → Acta; convocatória por meio com evidência de envio; quórum via `ResolutionRule`; deliberação eficaz na aprovação; votação no portal; assinatura/subscrição; documento final vs. aprovado; comunicação de deliberações separada; áudio eliminado após aprovação.

**Lançamento comercial geral:** F5 completo + [PRODUCTION-GATES.md](PRODUCTION-GATES.md).

---

## F6 — Orquestra LLM

**Objectivo:** Maestro + 5 especialistas + memória + validação em camadas.

| Item | Detalhe |
|------|---------|
| Maestro | Router de especialistas |
| Memória Única | Por tenant; **nunca** fonte de verdade de saldo/dívida |
| Base partilhada | Genérica, anonimizada, curada |
| Especialistas | Financeiro (Ledger), Jurídico (consultivo), Comunicação (única boca), Operações, Assembleia (`ResolutionRule`) |
| Validação em Camadas | Schema + Domain Rules + Legal → Risk Engine → AUTO / Aprovação / Escalação |
| Custo | Tokens por tenant |

**Critério:** input → maestro → especialista → validação em camadas → comunicação.

### Tier 3 (visão futura — não implementar em F6)

- Assembly → Project → Procurement → Contract
- Autonomy Rate como métrica de produto
- Benchmarking entre tenants

---

## Capacidade e freeze de scope

- **Sem distribuição além do piloto** enquanto F0–F2 não estiverem estáveis.
- **Freeze** de features “nice” de **F4–F6** até haver **10 tenants pagos** ou até ao **fim do piloto** — o que ocorrer primeiro. Excepções só com decisão explícita registada (ADR/Audit), não por impulso de venda.
- **WIP limit em F0:** no máximo **duas** frentes F0 em curso em paralelo (ex.: Domain Kernel + Job/Outbox); o resto fica em fila. Evita o founder abrir multi-tenant + GTM + UI + sync ao mesmo tempo.
- **Critério comercial do piloto (negócio):** champion nomeado + assembleia ≤60 dias — ver checklist em [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md).

---

## Dependências e gates (piloto vs comercial)

```
F0 ──→ F1 ──→ F2 ──┐
                    ├──→ F3 Essencial ──→ ★ PILOT LAUNCH
                    │                      (sem votação)
              F2 ──→ F4 ──→ F5 ──┐
                                 ├──→ Production Readiness Gates
                                 └──→ ★ GENERAL COMMERCIAL LAUNCH
F5/F4 estáveis ─────────────────→ F6 (Orquestra)
```

| Gate | Condição |
|---|---|
| Implementar F0/F1 | Freeze documentação v6.1 |
| Implementar F2 | F0 kernel + fatia F1 OK |
| Pilot launch | F0–F3 Essencial (tabela acima); votação **fora** |
| General commercial launch | F5 + [PRODUCTION-GATES](PRODUCTION-GATES.md) |
| Dinheiro / ops / legal em produção | NO-GO até aos Production Readiness Gates |

- UI de F3 pode desenvolver-se cedo; release com saldos espera F2.
- F6 só quando o domínio (incl. Policy Engine / SettlementPolicy / ResolutionRule) já existir.
