# 02 — Domínio (Bounded Contexts)

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> **Nota complementar (v6.1):** meio de convocatória por condómino (campos em `Membership`, sem entidade nova); `ConvocationDispatch` separado de `DeliberationNoticeDispatch` (art. 1432.º n.º 9); pipeline explícito convocatória → reunião → Acta → assinatura/subscrição → comunicação aos ausentes; ciclo de vida `Reuniao` com `RecordingSegment` (gravação contínua ≠ fim da reunião); ADRs 041–042. Contagem dos 10 dias e efeitos do recibo de email: **validação legal obrigatória** — não fechados neste pacote.
>
> **Nota desta revisão (v6.1):** consistency hardening — conjunto inicial de Roles inclui `Fiscalizacao` (capacidade de controlo, não entidade `ConselhoFiscal`); modelo de dinheiro com `cash_status` + `verification_method` e invariante registante ≠ verificador; especificação rigorosa da hash-chain do Ledger (deteção de adulteração, sem overclaim); máquina de estados da Acta alargada até `PUBLISHED`; retenção diferenciada por categoria; requisito arquitetural de saída do tenant / portabilidade; Knowledge Base legal e gates de produção apontados nos ADRs 036–040.
>
> **Nota v6 (mantida):** Acta distingue **assinatura** (presidente) de **subscrição** (todos os condóminos presentes), conforme art. 1.º do DL 268/94 (redação da Lei 8/2022); dois hashes distintos (aprovada vs. final); pagamentos em dinheiro com controlo de fraude; hash-chain no Ledger; meta-regra lei > regulamento; núcleo financeiro/governança nunca depende de LLM.
>
> **Nota v4/v5 (mantida):** estados explícitos a `Payment` (válido mesmo sem `Allocation`), fluxo `Ledger → AccountingPeriod → Reports` unidirecional, `Scope`/`Permission` leve em `Membership`, `BankConnection` (ligada à conta do condomínio, não ao admin), `FinancialDocument` (nunca fonte de verdade), `TenantDirectory` como requisito de F0.
>
> **Nota v3 (mantida):** correção do FCR, Obligation/Payment/Allocation/Ledger substitui `Quota.pago`, `Membership` substitui `user.role` fixo, remoção **definitiva** do QR físico, `ResolutionRule` (quórum não hardcoded), `AccountingPeriod` (três blocos), `AuditEvent` obrigatório.
>
> Esta não é uma lista de patches — é o mesmo domínio, com as fronteiras que faltavam.

## Glossário

| Termo | Definição |
|-------|-----------|
| **Tenant** | Um condomínio = 1 base de dados isolada |
| **Fração** | Unidade autónoma (apartamento, loja, garagem) |
| **Permilagem** | Quota-parte (‰) da fração no total do prédio |
| **Person** | Identidade única de uma pessoa — pode ter várias Memberships (ex: proprietária de A, representante de B) |
| **Membership** | Vínculo entre uma Person, um Tenant, opcionalmente uma Fração, um Role e um Scope opcional — é isto que dá acesso, nunca um QR; inclui preferência de meio de convocatória (art. 1432.º), não uma entidade à parte |
| **ConvocationDispatch** | Evidência de envio de convocatória (canal, destino, entrega, recibo, versão) — distinta da comunicação posterior das deliberações |
| **DeliberationNoticeDispatch** | Evidência de comunicação das deliberações aos ausentes (art. 1432.º n.º 9) — **nunca** misturada com convocatória |
| **RecordingSegment** | Segmento de áudio de uma `Reuniao` contínua (ordinal, início/fim, motivo de fecho) — falha técnica não termina a reunião |
| **Role** | Papel dentro de um Membership. Conjunto inicial: `Owner`, `CoOwner`, `Proxy`, `Admin`, `PlatformAdmin`, `Fiscalizacao` — extensível; outros papéis (Accountant, Lawyer, etc.) ficam adiados |
| **Fiscalizacao** | Role de **capacidade de controlo**: confirma ações sensíveis, não as cria. Não é obrigatório atribuir; não é uma entidade `ConselhoFiscal` com UI própria |
| **Scope/Permission** | Restringe o alcance de um Role (ex: "Admin" não implica automaticamente acesso absoluto a tudo) — modelo de dados já preparado, RBAC completo não construído agora |
| **Convite (Invitation)** | Mecanismo único de onboarding de uma pessoa a uma fração — privado, de uso único, revogável, expira; inclui **verificação de contacto** (email/telefone), não verificação de identidade civil |
| **Obligation (Obrigação)** | Valor que uma fração deve, por rubrica e período — deriva sempre de uma deliberação/orçamento aprovado, nunca inventada por um algoritmo |
| **Payment (Pagamento)** | Dinheiro efetivamente recebido — válido mesmo sem nenhuma Allocation associada |
| **Allocation (Alocação)** | Ligação entre um Payment e uma ou mais Obligations que ele liquida, total ou parcialmente |
| **Ledger / LedgerEntry** | Livro-razão append-only e única fonte de verdade financeira; cada entrada entra numa hash-chain de deteção de adulteração (ver secção dedicada) |
| **AccountingPeriod** | Camada de reporting/fecho **sobre** o Ledger — nunca um segundo lugar onde estado financeiro é guardado independentemente |
| **SettlementPolicy** | Política versionada que define a ordem de imputação de um Payment contra Obligations em aberto — separa regra legal fixa de preferência configurável |
| **FCR** | Fundo Comum de Reserva — obrigação própria, **não uma retenção percentual sobre pagamentos** (ver Invariante 2) |
| **BankConnection** | Ciclo de vida da ligação bancária (Enable Banking/PSD2) — ligada à conta do condomínio, não à pessoa do admin; sobrevive a troca de administrador |
| **FinancialDocument** | PaymentNotice (Aviso de Débito) / Receipt (Recibo) / AccountStatement (Extrato) — representação imutável de um estado financeiro, nunca fonte de verdade |
| **TenantDirectory** | Registo central (fora das BDs de tenant) de metadados operacionais por tenant — provisionamento, backups, migrations, observabilidade |
| **Rubrica** | Categoria de despesa/obrigação (CC, FCR, elevador, obras…) |
| **ResolutionRule** | Regra que determina quórum/maioria aplicável a um tipo de Deliberação — nunca uma percentagem fixa universal inventada pelo produto |
| **Acta** | Documento legal de assembleia, com deliberações e votos — máquina de estados até `PUBLISHED` (ver abaixo) |
| **Ticket** | Pedido de condómino (avaria, reclamação, sugestão) |
| **Orçamento** | Pedido de cotação para obra/serviço |
| **Reunião Admin** | Reunião informal do admin com fornecedor/advogado/câmara, gravada e resumida — admin-only, nunca prova legal (ver 03-ORQUESTRA) |
| **AuditEvent** | Registo imutável de qualquer alteração de estado relevante (who/what/when/before/after/reason/source) |

## Bounded Contexts

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                  TENANT (1 BD)                                    │
│                                                                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │ Identidade & │ │ Constituição │ │  Financeiro  │ │  Operações   │ │Assembleia│ │
│  │   Acessos    │ │              │ │              │ │              │ │/Governança│ │
│  │              │ │              │ │              │ │              │ │          │ │
│  │ • Person     │ │ • frações    │ │ • Obligation │ │ • tickets    │ │ • reuniões│ │
│  │ • Membership │ │ • permilagem │ │ • Payment    │ │ • orçamentos │ │ • Deliberação│ │
│  │ • Role       │ │ • reg.interno│ │ • Allocation │ │ • fornecedores│ │ • ResolutionRule│ │
│  │ • Invitation │ │ • IBANs      │ │ • Ledger     │ │ • reuniões   │ │ • votos  │ │
│  │ • Fiscalizacao│ │             │ │ • SettlementPolicy│ │  admin  │ │ • actas  │ │
│  │              │ │              │ │ • AccountingPeriod│ │        │ │          │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────┬─────┘ │
│         │                │                 │                │              │       │
│  ┌──────▼────────────────▼─────────────────▼────────────────▼──────────────▼────┐ │
│  │                     Memória Única do Prédio (por tenant)                    │ │
│  │   Factual State (DB/Domain Services) │ Documentos (RAG) │ Histórico Operac. │ │
│  │   REGRA DE OURO: Vector DB/RAG NUNCA é fonte de verdade para factos         │ │
│  │   financeiros — saldo/dívida vem sempre do Ledger via Domain Services       │ │
│  └───────────────────────────────────┬──────────────────────────────────────────┘ │
│                                       │                                            │
│  ┌────────────────────────────────────▼─────────────────────────────────────────┐ │
│  │         Domain Events + Job Queue + Audit Log + Policy Engine (desde F0)      │ │
│  └────────────────────────────────────┬─────────────────────────────────────────┘ │
│                                       │                                            │
│  ┌────────────────────────────────────▼─────────────────────────────────────────┐ │
│  │                  ORQUESTRA — Maestro + 5 Especialistas LLM                    │ │
│  │              (camada interpretativa, não decide sozinha — ver 03)             │ │
│  └────────────────────────────────────┬─────────────────────────────────────────┘ │
│                                       │                                            │
│  ┌────────────────────────────────────▼─────────────────────────────────────────┐ │
│  │           Comunicação (única boca) + validação em camadas (ver 03)           │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

> **Nota de framing:** a longo prazo, este domínio pode ser lido como um "Building Digital Twin" — Pessoas, Património, Finanças, Operações, Governança, Documentos, tudo emitindo Domain Events. Isto é uma lente conceptual útil para organizar o pensamento (ver diagrama de Domínio no ficheiro de arquitetura), **não uma exigência de construir mais estrutura agora**. O que está descrito abaixo é o suficiente para F0-F6; o resto é direção, não backlog.

## Entidades principais

### Identidade & Acessos

- `Person` — nome, NIF, email, telefone. Identidade única; pode ter múltiplas `Membership` (ex: proprietária da fração A, representante da fração B, admin de outro tenant)
- `Membership` — person_id, tenant_id, fracao_id (nullable — admin de plataforma não tem fração), role, scope (opcional — restringe o alcance de um role; ex: "Admin" não implica automaticamente acesso absoluto a tudo), estado (ativo/revogado), criado_em, criado_por. **É isto que concede acesso — nunca um QR ou token físico.** Campos de **meio de convocatória** (não são entidade nova — ADR-026 / ADR-041):
  - `convocation_channel`: `registered_mail` | `authorized_email` | `other_admissible` | `unknown` — meio preferido / aplicável a este vínculo (art. 1432.º n.ºs 1–3). O sistema **aplica** a configuração validada; **não “decide direito” sozinho**
  - `convocation_email` — endereço a usar quando o canal é `authorized_email` (o email de login da Person pode diferir)
  - `authorized_in_acta_id`, `authorized_at` — evidência da manifestação de vontade lavrada em acta (art. 1432.º n.º 2): qual acta e quando. Obrigatórios para AUTO SEND em `authorized_email`
  - **Regra de envio:** canal `unknown`, canal em falta, ou `authorized_email` sem autorização/`convocation_email` válidos → **HUMAN REVIEW**, **nunca AUTO SEND**
- `Role` — enumerável mas **extensível por design**. **Conjunto inicial obrigatório:** `Owner`, `CoOwner`, `Proxy` (representante), `Admin`, `PlatformAdmin`, `Fiscalizacao`. Outros papéis (Accountant, Lawyer, Technician, CommitteeMember) ficam previstos na estrutura mas **não implementados agora** — não construir o que não tem utilizador ainda
- `Fiscalizacao` — **Role de capacidade de controlo**, não uma entidade `ConselhoFiscal` nem um módulo de UI obrigatório. Quem o tem pode **confirmar** ações sensíveis (ex.: passar dinheiro a `verified` pelo método `second_person`); **não cria** essas ações. **Não é obrigatório atribuir** este role a ninguém num tenant; o modelo tem de o permitir desde F0. Sem pessoa com `Fiscalizacao`, o único caminho de verificação de dinheiro é `bank_deposit` (ver invariante 24)
- `Permission`/`Scope` — não se implementa um RBAC completo agora, mas o modelo de dados já separa "que role tenho" de "sobre o que exatamente esse role tem poder", para não bloquear autorização granular no futuro (ver ADR-LOG)
- `Invitation` — id, tenant_id, fracao_id, canal (email/sms), destinatário_contacto, token (opaco, uso único, expira em poucos dias), estado (pendente/aceite/expirado/revogado), criado_por, criado_em, lote_id (nullable — liga convites enviados em massa após importação de contactos, ver 04-PORTAS). **Único mecanismo de onboarding de um condómino.** O fluxo inclui **verificação de contacto** (prova de posse do email/telefone), **não verificação de identidade civil** (Cartão de Cidadão / biometria / KYC) — ver ADR-001

### Plataforma (Cross-tenant)

- `TenantDirectory` — registo central (fora de qualquer BD de tenant) com campos concretos: `tenant_id`, `db_ref`, `schema_version`, `status`, `region`, `plan`, `created_at`, `migration_status`, `backup_status`, `encryption_key_ref`. Não precisa de ser sofisticado — precisa de existir antes de haver dezenas de bases. **Requisito explícito de F0**, não melhoria futura: 1 BD por tenant reduz risco de fuga de dados entre condomínios, mas multiplica a superfície operacional (provisionamento, migrations, backups, restore, observabilidade, secrets, disaster recovery × N bases de dados) — sem um diretório central, isto não escala de forma gerível

### Constituição

- `Condominio` — morada, NIF, IBAN, regulamento_pdf_url
- `Fracao` — número, tipo, permilagem, quota_mensal (proprietário já não é campo desta entidade — é uma `Membership` com role `Owner` apontando para esta fração)
- `RegulamentoInterno` — texto_parsed, regras[], penalizações[]

### Financeiro (redesenhado)

- `Obligation` — id, fracao_id, tipo (quota_corrente / FCR / extraordinária / dívida_antiga), período, data_vencimento, valor, valor_em_aberto, estado (aberta/parcial/paga/anulada), base_legal, criado_de (referência à deliberação/orçamento anual que a gerou — **uma `Obligation` nunca é criada só porque um algoritmo calculou um valor; deriva sempre de uma deliberação/orçamento válido**)
- `Payment` — id, movimento_bancario_id (nullable — pode ser manual), valor, recebido_em, referência_pagador, **estado_alocação** (`identificado` / `parcialmente_alocado` / `totalmente_alocado` / `não_alocado_pendente`) — **ortogonal** aos estados de dinheiro, payment_method (`bank_transfer` / `direct_debit` / `cheque` / `cash` / `other`), e campos só relevantes se `payment_method = cash`:
  - `cash_status`: `registered` | `verified` | `deposited`
  - `verification_method`: `second_person` | `bank_deposit` — **obrigatório ao entrar em `verified`**
  - `evidencia_url` — foto/scan do recibo físico entregue, **obrigatória para cash**
  - `registado_por` (Membership) — quem lançou `registered`
  - `confirmado_por` (Membership, nullable) — quem verificou; **obrigatório e distinto de `registado_por` quando `verification_method = second_person`**
  - `deposit_deadline` — prazo de depósito derivado da config do tenant (default: **5 dias úteis** após `registered`)
  - **`Payment` é financeiramente válido mesmo sem nenhuma `Allocation`** — pode existir e ser reportado nesse estado indefinidamente. **Uma Obligation nunca fica liquidada de forma definitiva só com `cash_status = registered`** — ver invariante 24
- `Allocation` — payment_id, obligation_id, valor, policy_id (qual `SettlementPolicy` decidiu), confiança, aprovado_por (admin, se manual), criado_em
- `Ledger` — não é uma tabela de saldos cacheados: é a **regra de escrita append-only** sobre `LedgerEntry` (ver secção Hash-Chain). Nenhuma `Allocation` é editada ou apagada; uma correção é sempre uma nova entrada de ajuste. O saldo de uma fração é sempre reconstruído por soma: `Σ Obligation.valor − Σ Allocation.valor (+ ajustes)`, nunca lido de um campo de saldo cacheado sem poder ser recalculado. **O Ledger é a única fonte de verdade financeira — fluxo sempre unidirecional: `Ledger → AccountingPeriod → Reports/Statements`, nunca o inverso.** `AccountingPeriod` é uma camada de reporting/fecho sobre o Ledger, não um segundo lugar onde estado financeiro é guardado independentemente
- `SettlementPolicy` — version, effective_from, regras[] (ordem de imputação entre tipos de Obligation em aberto), legal_basis[], estado, supersedes (versão anterior substituída). **O admin configura preferências dentro dos limites que a política permite — nunca decide o que é legalmente devido**
- `AccountingPeriod` — tenant, período (mês/ano), estado (aberto/fechado), posted_transactions[] (reconciliadas), pending_transactions[] (por confirmar), adjustments_after_close[] (correções depois do fecho). **Lê do Ledger, nunca guarda um saldo financeiro paralelo**
- `BankConnection` — provider, ASPSP, conta bancária associada (**ligada à conta do condomínio, nunca à pessoa do admin** — sobrevive a troca de administrador), consent_status, consent_valid_until, last_sync_at, last_sync_error, reauthorization_required (bool), authorized_by (Membership com poder sobre a conta), revoked_at. Ciclo de vida gerido automaticamente (renovação técnica de tokens é responsabilidade do provider, ex: Enable Banking); só pede intervenção humana quando o **consentimento do utilizador** (não o token técnico) expira ou precisa de reautorização
- `FinancialDocument` — id, tenant_id, fracao_id, tipo (`PaymentNotice` / `Receipt` / `AccountStatement`), período, issued_at, due_at (quando aplicável), valor, status, document_number, pdf_url, generated_from (referência rastreável a `Obligation`/`Payment`/`Allocation`/Ledger — nunca solto), sent_at, delivery_status. **`FinancialDocument` nunca é fonte de verdade** — é uma representação imutável do estado financeiro num momento, sempre reconstruível a partir de Obligation/Payment/Allocation/Ledger
- `Recibo` — descontinuado como entidade própria; passa a ser `FinancialDocument` de tipo `Receipt` (ver acima)
- `MovimentoBancario` — data, valor, descritivo, IBAN_origem, reconciliado, fração_match, estado (confirmado/pendente_confirmação)

### Operações

- `Ticket` — fração_origem, assunto, descrição, fotos[], estado, prioridade (calculada por heurística determinística: urgência × risco × impacto × prazo — nunca só "opinião" do LLM sozinho, ver 03-ORQUESTRA)
- `Orcamento` — area, tipo, descrição, urgência, cotações[3], fornecedores[5], SLA, recomendação, criterios_pesos (ex: preço 30% / SLA-qualidade 25% / garantia 15% / prazo 10% / histórico 10% / risco 10% — pesos default, configuráveis, nunca "mais barato" como critério único), confianca_recomendação (Alta/Média/Baixa — qualitativo; **nunca um score numérico artificialmente preciso quando faltam dados**, ex: "sem dados de garantia" → confiança Média, não "87/100"), decision_brief (representação renderizada das 5 perguntas fixas — ver 03-ORQUESTRA — gerada a partir dos dados acima, não um registo à parte), **decision_brief_versao** (incrementa sempre que preço, fornecedor, duração, âmbito, condições, risco ou autoridade necessária mudam — ver invariante 20)
- `Fornecedor` — nome, NIF, categoria, avaliação, histórico (preços anteriores, cumprimento de SLA, incidentes — a "memória operacional do edifício" sobre quem já trabalhou lá)
- `Contract` — id, fornecedor_id, tipo (manutenção/limpeza/seguro/elevadores/inspeção — **não são entidades separadas, são valores deste campo**), valor, periodicidade, data_inicio, data_fim, prazo_aviso_previo, documentos[], estado (ativo/a_renovar/encerrado). **Versão leve, deliberadamente:** o sistema lembra automaticamente antes do prazo de aviso prévio (job agendado, ver 06-FATIAS F4) — não pesquisa mercado nem negocia sozinho ainda; isso fica Tier 3 (ver 03-ORQUESTRA). `Contract` é **um dos contextos que pode originar uma decisão, não o centro da autoridade** — ver `AuthorityRule`/`Approval` abaixo
- `ReuniaoAdmin` — tipo (fornecedor/advogado/câmara/outro), data, áudio_url (eliminado logo após extração do resumo — ver política de retenção abaixo), transcrição, resumo, promovida_para_assembleia (bool), visível_a (admin-only por defeito)

### Assembleia / Governança

- `Reuniao` — data prevista / realizada, referência à convocatória (versão), ciclo de vida e segmentos de áudio (ver secção **Reunião — ciclo de vida e gravação** abaixo). O campo legado `áudio_url` deixa de ser o modelo canónico: o áudio vive em `RecordingSegment[]` (temporário — política de retenção e invariante 9). Uma `Reuniao` tem **no máximo uma** `Acta`
- `RecordingSegment` — reuniao_id, ordinal (ordem de consumo STT), started_at, ended_at (nullable enquanto aberto), reason_ended (`user_stop_segment` | `technical_interrupt` | `user_end_meeting`), storage_path, byte_size, status. Vários segmentos por reunião; falha técnica **não** fecha a reunião
- `ConvocationDispatch` — evidência de envio da **convocatória** (pode modelar-se como registos tipados de outbox/auditoria, sem exigir entidade “enterprise” pesada): channel usado, destination, sent_at, delivery_state, receipt_at / receipt_ref, convocation_version, initiated_by, failures[], resend_of (nullable — aponta para o envio anterior se for reenvio). **Não** serve para comunicar deliberações
- `DeliberationNoticeDispatch` — evidência da **comunicação das deliberações aos ausentes** (art. 1432.º n.º 9). Campos análogos de canal/destino/entrega/recibo, mas domínio e pipeline **separados** da convocatória — preferências e envios podem coincidir na prática; o modelo trata-os como fluxos distintos
- `Acta` — reunião, texto, deliberações[], votos[], participantes[], estados e artefactos descritos na secção **Acta — máquina de estados (v6.1)** abaixo
- `Participante` (parte de `Acta`, não entidade própria) — **snapshot histórico no momento da reunião**, não uma vista live de `Membership`: nome_apresentado, qualidade (ex: Owner/Proxy), fracao_id, permilagem_no_momento, membership_id (referência opaca ao vínculo de origem, se ainda existir), presente (bool), representado_por (snapshot do proxy, nullable), estado_subscricao (`pendente` / `assinatura_manuscrita` / `assinatura_eletronica_qualificada` / `declaracao_eletronica` / `nao_aplicavel_ausente`), subscrito_em, meio_usado. **Alterações posteriores a Membership não reescrevem Participante**
- `Deliberacao` — assunto, tipo, resolution_rule_id (qual regra determinou quórum/maioria aplicável), resultado, votos[]
- `Voto` — **snapshot histórico** (não Membership live): fração, sentido (sim/não/abstenção), permilagem_no_momento, nome/qualidade do votante, proxy se aplicável
- `ResolutionRule` — tipo_deliberacao, base_legal (artigo do CC/DL 268/94), quórum_1ª_convocatória, quórum_2ª_convocatória, maioria_necessária, fonte (lei vs. regulamento do condomínio, quando mais exigente que a lei). Seed inicial com os valores do artigo 1432.º; **motor de regras, não percentagem hardcoded no código**. **Não inventar uma % universal de "aprovação da Acta"** — a regra de aprovação da Acta segue `ResolutionRule` / lei / regulamento, com **gate de advogado antes de produção**

### Pipeline de assembleia (separação explícita)

Ordem conceptual — cada passo é um domínio/evento distinto; **não colapsar**:

1. **Convocatória** — meio por condómino (`Membership.convocation_*`) + evidência em `ConvocationDispatch`
2. **Realização da assembleia** — `Reuniao` (`DRAFT` → `IN_PROGRESS` → `ENDED`) com `RecordingSegment[]`
3. **Aprovação da Acta** — máquina de estados até `APPROVED` (eficácia das deliberações)
4. **Assinatura / subscrição** — presidente assina; presentes subscrevem (`SIGNATURES_PENDING` → `FINAL` / `PUBLISHED`)
5. **Comunicação das deliberações aos ausentes** — `DeliberationNoticeDispatch` (art. 1432.º n.º 9), **nunca** misturada com o passo 1

**Validação legal obrigatória (não fechada neste pacote):** contagem exacta dos **10 dias** de antecedência (expedição vs. receção — jurisprudência divergente); validade prática e consequências do **recibo de receção por email** (n.º 3) se o condómino não o enviar; meios `other_admissible` concretos. O produto **não inventa** percentagens nem fecha esta disputa.

### Cross-cutting: Autoridade de Decisão

- `AuthorityRule` — tipo_decisão (ex: renovação de contrato, alteração de preço, rescisão, contratação de novo fornecedor, obra, seguro, inspeção, pagamento extraordinário — **um vocabulário de tipos de decisão, não uma ligação a `Contract` especificamente**), limiar_valor (a partir de quando muda a autoridade necessária), autoridade_necessária (Admin / Assembleia / outro), base (regulamento do condomínio ou lei). **A pergunta que responde é "quem pode autorizar esta ação concreta, neste contexto?", nunca só "quem pode aprovar contratos?"** — mesma correção já aplicada ao quórum (`ResolutionRule`, ADR-005), agora aplicada a "quem pode aprovar o quê". Consultada pelo Risk Engine (ver 03-ORQUESTRA) antes de qualquer decisão operacional avançar para AUTO/Aprovação/Escalação.
- `Approval` — id, tipo_decisão, contexto_tipo (`Orcamento`/`Contract`/outro), contexto_id, decision_brief_versao (**a versão exata do brief aprovada — não "o brief mais recente"**), valor, authority_rule_id (e versão dessa regra, se a regra mudar entretanto), decision_brief_snapshot/evidence (referência ao brief exato apresentado — nunca regenerado depois, para nunca divergir do que foi realmente aprovado), actor/aprovado_por (Membership), scope (o que exatamente foi autorizado — ex: "aprovar Opção B até €2.040/ano", não um "sim" genérico), aprovado_em, resultado (aprovado/rejeitado/pedido de mais informação). **Fecha a cadeia de rastreabilidade:** Decision Brief (versão N) → dados utilizados → AuthorityRule (versão M) → Approval → (Execution, Tier 3). Sem `Approval`, "quem aprovou o quê, com que autoridade, com base em que dados, em que versão" fica só implícito no `AuditEvent` — com `Approval`, fica um registo explícito e consultável, essencial se algo correr mal e precisar de defesa legal.

### Cross-cutting: Auditoria

- `AuditEvent` — who, what, when, tenant, before, after, reason, source, request_id. Campos adicionais quando a origem é uma ação de IA: model, model_version, prompt_version, knowledge_version, tools_called, confidence, policy_version, human_approval. Também regista ruturas/reparações da hash-chain (ver secção Ledger)
- `DomainEvent` — evento publicado por qualquer mudança de estado relevante (ex: `ObligationCreated`, `PaymentAllocated`, `ActaAprovada`); consumido por Jobs, Audit, e futuramente pela camada de IA — infraestrutura desde F0, não esperar por F6

---

## Reunião — ciclo de vida e gravação (complemento v6.1)

Ciclo de vida da `Reuniao` (Assembleia):

`DRAFT → IN_PROGRESS → ENDED` → processamento (STT sobre segmentos → elaboração da Acta)

| Estado | Significado |
|--------|-------------|
| `DRAFT` | Reunião criada / agendada; ainda sem gravação activa |
| `IN_PROGRESS` | Assembleia em curso; pode haver gravação activa, pausada por interrupção técnica, ou idle com sessão aberta |
| `ENDED` | **Só** por intenção humana explícita de terminar a reunião (`user_end_meeting` no segmento final ou acção equivalente). Depois segue STT/Acta |

Sub-estados de gravação (derivados dos segmentos, não uma segunda máquina paralela obrigatória):

| Sub-estado | Significado |
|------------|-------------|
| `recording` | Segmento aberto a gravar |
| `interrupted` | Último segmento fechado com `technical_interrupt`; reunião continua `IN_PROGRESS` |
| `idle_open` | Reunião aberta sem segmento a gravar (ex.: após `user_stop_segment`, antes de retomar ou terminar) |

### `RecordingSegment`

- `reuniao_id`, `ordinal` (inteiro crescente), `started_at`, `ended_at`, `reason_ended` (`user_stop_segment` | `technical_interrupt` | `user_end_meeting`), `storage_path`, `byte_size`, `status`
- Persistência **progressiva** (chunks / upload resumível) — um ciclo MediaRecorder ≠ uma nova `Reuniao`
- STT consome segmentos por **ordinal** crescente
- **Uma Acta por Reuniao**; vários segmentos alimentam a mesma Acta

### Áudio e retenção

A política de retenção **não muda**: hard-delete do áudio da Assembleia após `Acta.APPROVED` (invariante 9) cobre **todos** os segmentos dessa `Reuniao` de uma vez. O mesmo princípio de continuidade aplica-se a reuniões admin com MediaRecorder (F4): segmentos onde houver gravação contínua; áudio admin continua a eliminar-se após extração do resumo.

---

## Acta — máquina de estados (v6.1)

Estados, nesta ordem:

`DRAFT → SUBMITTED_FOR_APPROVAL → APPROVAL_IN_PROGRESS → APPROVED → PRINT_READY → SIGNATURES_PENDING → DOCUMENT_SUBMITTED → FINAL → PUBLISHED`

| Estado | Significado |
|--------|-------------|
| `DRAFT` | Texto em elaboração (admin / LLM assistido) |
| `SUBMITTED_FOR_APPROVAL` | Submetida ao fluxo de aprovação |
| `APPROVAL_IN_PROGRESS` | Aprovação em curso segundo `ResolutionRule` / lei / regulamento |
| `APPROVED` | Conteúdo aprovado e **congelado**; deliberações eficazes (art. 1.º n.º 3 DL 268/94) |
| `PRINT_READY` | Versão **exata** aprovada disponível para impressão (hash = `hash_aprovada`) |
| `SIGNATURES_PENDING` | Aguarda assinatura do presidente e/ou subscrições dos presentes |
| `DOCUMENT_SUBMITTED` | Documento físico/eletrónico assinado/subscrito submetido ao sistema |
| `FINAL` | Documento final arquivado (`hash_final`); validação estrutural OCR/LLM concluída |
| `PUBLISHED` | Acta final assinada/subscrita disponibilizada no portal aos condóminos |

### Distinções obrigatórias (nunca colapsar)

- **Aprovação da Acta ≠ voto de deliberação ≠ assinatura do presidente ≠ subscrição dos presentes ≠ presença**
- Cada um é um evento/estado distinto no domínio
- A regra de **quem aprova a Acta** vem de `ResolutionRule` / lei / regulamento aplicável — **não se inventa uma percentagem universal no produto**. Gate de advogado especializado em propriedade horizontal **antes de produção**

### Regras de conteúdo e portal

- Em `APPROVED`, o conteúdo fica **congelado**. Qualquer alteração material ao texto/deliberações **invalida a aprovação** (volta a fluxo de aprovação; aprovação antiga fica no histórico auditável — nunca apagada)
- No **portal**, durante `APPROVAL_IN_PROGRESS` / estados anteriores a `PUBLISHED` relevantes para aprovação, o condómino autorizado vê o **draft submetido à aprovação** para a ação de aprovar
- A **Acta final assinada/subscrita** só é mostrada no portal quando o estado é `PUBLISHED`
- `PRINT_READY`: imprime exatamente a versão aprovada (a que corresponde a `hash_aprovada`)
- OCR/LLM na validação pós-submissão: **apenas comparação estrutural** (n.º de páginas, presença de texto esperado, discrepâncias grosseiras). **Nunca declara que uma assinatura manuscrita é juridicamente válida**
- `hash_aprovada != hash_final` é **esperado e normal** — o documento final inclui assinaturas/subscrições; são artefactos distintos (ver invariante 23)
- `Participante` e `Voto` são **snapshots históricos** (nome, qualidade, fração, permilagem no momento, proxy) — não vistas live de `Membership`

### Áudio e APPROVED

- Hard-delete do áudio da Assembleia **após** a Acta entrar em `APPROVED` (ver invariante 9) — aplica-se a **todos** os `RecordingSegment` da `Reuniao`
- Se o job de eliminação falhar ou o fluxo ficar **preso depois de APPROVED** (ex.: nunca chega a `PRINT_READY` / `PUBLISHED`), o áudio **não** deve permanecer indefinidamente: política operacional = retry + alerta + eliminação forçada após prazo configurável, registando `AuditEvent`. O conteúdo aprovado (texto + hashes) é a referência; o áudio não é prova legal

### Correção legal (mantida)

Art. 1.º DL 268/94 (redação da Lei 8/2022): distingue **assinatura** da ata (presidente) de **subscrição** (todos os presentes). A subscrição admite assinatura manuscrita, assinatura eletrónica qualificada, ou declaração eletrónica anexada. Para o MVP suportamos o fluxo físico/manuscrito primeiro; o domínio já representa aprovação / assinatura / subscrição como eventos distintos. A eficácia das deliberações depende da **aprovação**, independentemente de estar assinada.

---

## Ledger — Hash-Chain (especificação técnica)

> **Limite explícito do que isto é:** a hash-chain é **evidência de adulteração / deteção de manipulação** de entradas. **Não** é imutabilidade absoluta. **Não** é blockchain. **Não** prova contra um atacante que reescreve a base de dados inteira (entradas + hashes + backups). Checkpoint / âncora externa = **Decisão Futura**, fora do core (ADR-029).

### O que constitui uma `LedgerEntry`

Uma `LedgerEntry` é o registo append-only de um facto financeiro no Ledger. Tipicamente corresponde a uma `Allocation` (incluindo alocações de ajuste/reversão) ou a outro lançamento financeiro canónico que afete saldos reconstruíveis. Cada entrada tem identidade estável (`entry_id`) e posição na cadeia do tenant.

### Campos que entram no hash

Entram no cálculo de `entry_hash` (conjunto canónico mínimo):

- `entry_id`
- `tenant_id`
- `sequence` (posição monotónica na cadeia do tenant)
- `created_at` (timestamp canónico UTC)
- `entry_type` (ex.: `allocation`, `adjustment`)
- payload de negócio estável (ex.: `payment_id`, `obligation_id`, `amount`, `currency`, `policy_id` / versão, `direction` credit/debit se aplicável)
- `previous_hash`
- `algorithm_version`

**Não entram no hash:** campos derivados recalculáveis, URLs mutáveis de UI, nem o próprio `entry_hash` (é o resultado).

### Serialização canónica

Antes do hash, o payload é serializado de forma **canónica e estável**:

1. Encoding UTF-8
2. Estrutura tipo JSON com **chaves ordenadas lexicograficamente** em todos os níveis
3. Sem whitespace significativo variável; números em representação decimal estável acordada
4. Timestamps em ISO-8601 UTC com precisão fixa
5. A especificação exata da serialização fica versionada com `algorithm_version` — mudar a serialização = bump de versão, nunca reinterpretar hashes antigos com regras novas

### `previous_hash` e `entry_hash`

- `previous_hash` = `entry_hash` da entrada imediatamente anterior na cadeia do mesmo tenant (ou valor génese para a primeira)
- `entry_hash` = `H( canonical_bytes(campos_que_entram_no_hash) )` onde `H` é a função definida por `algorithm_version`

### Algoritmo e versão

- Algoritmo inicial: **SHA-256**, digest em hex minúsculo
- Campo obrigatório: `algorithm_version` (ex.: `sha256-v1`)
- Mudança de algoritmo ou de conjunto de campos = nova `algorithm_version`; entradas antigas **não** são reescritas

### Entrada génese

- Cada tenant tem exactamente uma entrada génese (ou um `previous_hash` génese bem conhecido, constante documentada, ex. 64 hex zeros / sentinel versionado)
- A génese não representa um movimento financeiro real; ancora a cadeia

### Ordenação

- Ordem total por `(tenant_id, sequence)` com `sequence` monotónica crescente atribuída na escrita
- A ordem da cadeia **é** a ordem de `sequence`, não a ordem de chegada de requests HTTP

### Concorrência

- A atribuição de `sequence` e o cálculo de `previous_hash` ocorrem sob **exclusão mútua por tenant** (transação serializável / lock de append da cadeia)
- Duas escritas concorrentes no mesmo tenant: uma obtém `sequence = N`, a outra `N+1` com `previous_hash` da primeira — nunca duas entradas com o mesmo `sequence` ou o mesmo `previous_hash` apontando para pais diferentes sem deteção

### Validação da cadeia

Procedimento:

1. Percorrer entradas por `sequence` ascendente
2. Verificar que `previous_hash` da entrada N = `entry_hash` da N−1 (ou génese)
3. Recalcular `entry_hash` com a `algorithm_version` da entrada e comparar
4. Qualquer mismatch → cadeia **quebrada**

Validação corre em jobs periódicos e em caminhos de auditoria/export; não precisa de bloquear cada leitura de saldo do dia-a-dia, mas um break detetado é incidente de segurança/integridade.

### Comportamento quando a cadeia está quebrada

- Marcar o tenant/segmento afetado como `chain_integrity = broken`
- Alertar PlatformAdmin / operações
- **Proibir** escritas financeiras novas até política de reparação (ou modo degradado explícito só-leitura, conforme config)
- Emitir `AuditEvent` de rutura com detalhes (sequence, hashes esperados vs. encontrados)
- **Nunca** “reparar” em silêncio reescrevendo hashes históricos

### Quem pode reparar

- Reparação = **append-only**: novo lançamento de ajuste + `AuditEvent` explícito de tipo `ledger_chain_break` / `ledger_chain_repair`
- **Nunca** update/delete silencioso de entradas passadas nem rewrite da cadeia
- Autoridade: `PlatformAdmin` (e procedimento operacional documentado); não é self-service do Admin do condomínio

### Relação com `AuditEvent`

- Toda escrita de `LedgerEntry` gera `AuditEvent` de negócio
- Rutura e reparação geram `AuditEvent` de integridade distintos
- `AuditEvent` **não** substitui a hash-chain; a chain prova ligação criptográfica entre entradas; o audit prova who/what/when da operação

### Fora do core (Decisão Futura)

- Checkpoint periódico / âncora externa (ex.: timestamping, object storage imutável, notário digital) — **não** faz parte do core v6.1

---

## Dinheiro (`cash`) — modelo v6.1

`cash_status` e `estado_alocação` são **ortogonais**:

| Dimensão | Valores | Pergunta que responde |
|----------|---------|------------------------|
| `cash_status` | `registered` → `verified` → `deposited` | O dinheiro físico foi controlado / depositado? |
| `estado_alocação` | `identificado` / `parcialmente_alocado` / `totalmente_alocado` / `não_alocado_pendente` | O pagamento já foi imputado a Obligations? |

### Transições

1. **`registered`** — lançado por uma pessoa (`registado_por`); evidência fotográfica **obrigatória**
2. **`verified`** — exige `verification_method`:
   - `second_person`: outra Membership (tipicamente com role `Fiscalizacao`) confirma; **registante ≠ verificador** (mesmo Person / mesmo Membership proibido)
   - `bank_deposit`: depósito bancário associado / em curso de reconciliação dentro do prazo
3. **`deposited`** — existe `MovimentoBancario` correspondente reconciliado

### Regras de fraude / controlo

- Sem pessoa com role `Fiscalizacao` no tenant: **apenas** o caminho `bank_deposit` é permitido para `verified`
- **Proibido:** Admin regista → o **mesmo** Admin confirma (`second_person` consigo próprio), mesmo que também tenha `Fiscalizacao`
- Obligation **nunca** liquidada definitivamente só com `cash_status = registered` (pode haver alocação provisória/marcada, mas o estado definitivo de liquidação exige pelo menos `verified`, preferencialmente `deposited` — política exacta de liquidação provisória vs. definitiva fica no Domain Service, nunca “registered = pago”)
- Prazo de depósito: **configuração do tenant**; **default = 5 dias úteis** após `registered`. Ultrapassado o prazo sem `deposited` → alerta operacional + `AuditEvent` (não apaga o Payment)

---

## Retenção de documentos e dados

Política **diferenciada por categoria** — **"guardar para sempre" não é universal** (ADR-030):

| Categoria | Política |
|-----------|----------|
| Instrumentos legais do condomínio (Regulamento Interno, Actas em estado final/publicado, deliberações) | Retenção longa / indefinida — o original **é** o instrumento legal |
| Documentos financeiros gerados (`FinancialDocument`) | Retenção alinhada a obrigações legais/contabilísticas aplicáveis; reconstruíveis a partir do Ledger |
| Documentos pessoais de onboarding (comprovativo IBAN, eventual ID) | Minimização RGPD — retenção limitada; após purga do conteúdo, **hash + metadados** persistem para auditoria |
| Áudio de Assembleia | Hard-delete de **todos** os `RecordingSegment` após `Acta.APPROVED` (com fallback se stuck) |
| Áudio de Reunião Admin | Eliminado após extração do resumo (todos os segmentos da sessão, se aplicável) |

Prazos operacionais concretos (dias) para dados pessoais e áudio: **validar com advogado/DPO antes de produção**.

---

## Saída do Tenant / Portabilidade

**Requisito arquitetural** (ADR-037), mesmo que a implementação completa venha mais tarde — não pode ser esquecido nem tornado impossível pelo desenho:

O tenant (ou o seu representante autorizado) tem de poder obter:

1. **Exportação financeira** — Obligations, Payments, Allocations, LedgerEntries (incl. hashes), AccountingPeriods
2. **Documentos** — FinancialDocuments e documentos legais arquivados
3. **Actas** — versões aprovadas e finais, participantes/votos snapshot, hashes
4. **Histórico operacional** — Tickets, orçamentos, contratos leves, fornecedores relevantes
5. **Auditoria relevante** — AuditEvents necessários à reconstrução de “quem fez o quê”

Formato e SLA de exportação: decisão de implementação posterior; a arquitetura (1 BD/tenant + append-only + documentos endereçáveis) **não** deve criar obstáculos artificiais.

---

## Invariantes de Domínio

1. **Σ permilagens = 1000‰ — necessário mas não suficiente.** A confirmação do admin (F1) tem de ser linha a linha, com o excerto do PDF de origem visível junto a cada fração — trocar permilagem entre duas frações mantém a soma mas vicia a cobrança.
2. **FCR é uma Obligation própria, não uma retenção sobre pagamentos.** Segundo o art. 4.º do DL 268/94, a contribuição para o Fundo Comum de Reserva é de pelo menos 10% da quota-parte do condómino nas despesas do condomínio — é calculada no orçamento anual e gerada como uma `Obligation` de tipo `FCR`, tal como a quota corrente. **Nunca se retiram 10% de cada pagamento recebido.**
3. Um `Payment` **é uma entidade financeiramente válida mesmo sem nenhuma `Allocation` associada** — existe e é reportável no estado `não_alocado_pendente` indefinidamente, sem bloquear nada. Quando alocado, é sempre contra `Obligation`s em aberto através da `SettlementPolicy` vigente no momento. A ordem de imputação entre tipos de obrigação é uma preferência configurável dentro dos limites definidos pela política — nunca uma decisão arbitrária do admin sobre o que é legalmente devido. **Obligation ≠ Payment ≠ Allocation ≠ Ledger** — quatro conceitos distintos; nunca colapsar num boolean `Quota.pago`.
4. O Ledger é **append-only** e é a **única fonte de verdade financeira**: nenhuma `Allocation`/entrada passada é editada ou apagada; correções são sempre novos lançamentos de ajuste. O fluxo é sempre unidirecional — `Ledger → AccountingPeriod → Reports/Statements` — **nunca o inverso**. Cada `LedgerEntry` participa na **hash-chain** especificada acima (deteção de adulteração — não blockchain, não imutabilidade absoluta).
5. Quórum e maioria de uma `Deliberacao` (e a regra de aprovação da Acta) são determinados por `ResolutionRule` (tipo → base legal → regulamento do condomínio, se mais exigente) — **nunca uma percentagem fixa hardcoded universal inventada pelo produto**. Gate de advogado antes de produção.
6. **A autoridade necessária para uma decisão operacional (adjudicar orçamento, renovar contrato) é determinada por `AuthorityRule`** (tipo de decisão → limiar de valor → regulamento do condomínio, se mais exigente) — substitui o "Orçamento > limiar → assembleia adjudica" hardcoded como regra única (mesma correção do ADR-005, aplicada agora a este domínio).
7. `ReuniaoAdmin` só se torna visível a condóminos se explicitamente promovida para uma `Acta`/`Deliberacao` — nunca por defeito. **A promoção é sempre informativa/contextual, nunca documento probatório.** Se existir documento formal (contrato, proposta escrita), é esse — não o resumo gerado por LLM — que a acta deve referenciar como prova.
8. **Fecho de mês (`AccountingPeriod`) nunca fica bloqueado.** Fecha sempre na data prevista, com três blocos explícitos e distintos: saldo contabilístico fechado (posted), movimentos pendentes de confirmação (pending), e ajustes lançados depois do fecho (adjustments_after_close). Estes três números nunca se somam silenciosamente num único "saldo" — ficam sempre visíveis em separado, para o relatório ser auditável.
9. **Retenção de áudio (RGPD):** o áudio de `Reuniao` (Assembleia) — **todos** os `RecordingSegment` — é eliminado (hard-delete) após a Acta entrar em `APPROVED`; o áudio de `ReuniaoAdmin` é eliminado logo após a extração do resumo. Se o fluxo ficar preso após `APPROVED`, aplica-se retry + alerta + eliminação forçada com `AuditEvent`. Os prazos operacionais concretos são parâmetros a validar com advogado/DPO antes de produção.
10. **Toda alteração de estado relevante gera um `AuditEvent`** — sem exceção, incluindo ações tomadas por especialistas de IA e eventos de rutura/reparação da hash-chain.
11. **QR Code nunca é mecanismo de autenticação nem credencial de acesso.** O acesso de um condómino só existe através de um `Membership` criado pelo fluxo de `Invitation` (ver 04-PORTAS). Não existe, em nenhuma circunstância, um QR físico afixado numa fração, hall ou zona comum que conceda acesso a saldo, dívidas, documentos, recibos ou votação — esta é uma decisão arquitetural fechada (ver ADR-LOG).
12. **`BankConnection` liga-se à conta bancária do condomínio, nunca à pessoa do admin.** Troca de administrador não deve, por si só, invalidar a ligação bancária existente — só se pede nova autorização se o consentimento em vigor realmente exigir.
13. **`FinancialDocument` (PaymentNotice/Receipt/AccountStatement) nunca é fonte de verdade.** É sempre uma representação imutável, reconstruível a partir de Obligation/Payment/Allocation/Ledger via o campo `generated_from` — nunca um documento "solto" que possa divergir da verdade financeira se algo mudar depois.
14. **Isolamento por tenant (1 BD por condomínio) exige um `TenantDirectory` central desde F0**, não como melhoria futura — a superfície operacional multiplicada por N bases de dados não é gerível sem um registo central de estado por tenant.
15. **Toda recomendação de `Orcamento`/`Contract` tem de ser rastreável à sua origem** (preço → proposta do fornecedor, SLA → contrato/proposta, avaliação → histórico do `Fornecedor`) — nunca uma afirmação solta do especialista Operações sem dado verificável por trás.
16. **A recomendação de fornecedor considera "melhor valor" (preço + SLA + avaliação + histórico + garantias), nunca só o preço mais baixo.** Os pesos usados (`criterios_pesos`) ficam guardados e consultáveis.
17. **Nunca apresentar uma confiança numérica artificialmente precisa quando os dados são fracos.** Se falta informação, a `confianca_recomendação` é qualitativa ("Média — faltam dados sobre garantia"), nunca um score como "87/100".
18. **`AuthorityRule` responde "quem pode autorizar esta ação concreta, neste contexto", nunca "quem pode aprovar contratos".** `Contract` é um dos contextos que pode originar uma decisão — não é o centro da autoridade. O centro é a decisão em si, registada em `Approval`.
19. **Uma entidade só se cria quando existe necessidade real de persistência, integridade ou comportamento que as entidades existentes não conseguem representar** — nunca "porque um sistema enterprise provavelmente teria uma". Por isto **não existe entidade `ConselhoFiscal`**: usa-se o Role `Fiscalizacao`. Preferência de convocatória fica em campos de `Membership`, não numa entidade `ConvocationDeliveryPreference`.
20. **Qualquer alteração material ao objeto de uma decisão depois de aprovada invalida essa `Approval` — nunca se reaproveita silenciosamente.** Inclui preço, fornecedor, duração, âmbito, condições, risco, ou autoridade necessária. `Orcamento.decision_brief_versao` incrementa; a `Approval` antiga fica marcada como referente a uma versão anterior.
21. **Aprovação da Acta ≠ subscrição/assinatura da Acta (art. 1.º n.º 3 do DL 268/94).** A eficácia das deliberações depende da aprovação da ata, **independentemente de estar assinada**. Assinatura/subscrição é sobre o **documento**, não sobre a **validade da decisão**. Distinto também de voto de deliberação e de presença.
22. **Modelo de assinatura/subscrição da Acta:** a lei distingue assinatura (presidente) de subscrição (todos os presentes), e admite manuscrita / eletrónica qualificada / declaração eletrónica. `Participante.estado_subscricao` regista por pessoa. Validar com advogado especializado em propriedade horizontal antes de produção.
23. **`hash_aprovada` e `hash_final` são artefactos distintos** — o primeiro prova a versão aprovada (`PRINT_READY`); o segundo prova o ficheiro arquivado depois de assinado/subscrito. `hash_aprovada != hash_final` é esperado. OCR/LLM só compara estrutura; **nunca** valida juridicamente assinaturas manuscritas. A Acta final assinada só é portal-visível em `PUBLISHED`.
24. **Pagamentos em dinheiro — `cash_status` + `verification_method`:** `registered` → `verified` (`second_person` | `bank_deposit`) → `deposited`. Evidência fotográfica obrigatória. Em `second_person`, registante ≠ verificador. Sem `Fiscalizacao` atribuída: só `bank_deposit`. Proibido Admin regista → Admin confirma. Obligation nunca liquidada definitivamente só em `registered`. Prazo de depósito: config do tenant, **default 5 dias úteis**. Ortogonal a `estado_alocação`.
25. **Retenção diferenciada por categoria** — "keep forever" **não** é universal. Instrumentos legais (Regulamento, Actas) vs. documentos pessoais (ADR-030): lógicas distintas (instrumento legal vs. minimização RGPD).
26. **Meta-regra de conflito legal explícita:** lei (obrigatória, piso mínimo) > regulamento do condomínio (pode ser mais exigente que a lei, nunca pode contrariá-la). Toda `ResolutionRule`/`AuthorityRule` que consulte "lei vs. regulamento" segue esta hierarquia sem exceção.
27. **Funcionalidades financeiras/governança nucleares nunca dependem da disponibilidade de um provider LLM.** Ver saldo, votar, ver documentos, consultar Ledger têm de funcionar com Groq (ou qualquer LLM) em baixo — a IA é automação sobre o domínio, nunca dependência bloqueante.
28. **Saída do tenant / portabilidade é requisito arquitetural** — exportação financeira, documentos, Actas, histórico operacional e auditoria relevante devem ser possíveis; implementação completa pode ser posterior, o desenho não a pode impossibilitar (ADR-037).
29. **Efeitos assíncronos críticos (jobs, notificações, side-effects financeiros/governança) são idempotentes e observáveis desde F0** — retry seguro, deduplicação por chave, visibilidade de falha; "fire-and-forget" sem telemetria é insuficiente (ADR-038).
30. **Convocatória ≠ comunicação das deliberações (art. 1432.º).** Meio e evidência de convocatória (`Membership.convocation_*` + `ConvocationDispatch`) são distintos de `DeliberationNoticeDispatch` (n.º 9). Canal `unknown` / autorização em falta → **HUMAN REVIEW**, nunca AUTO SEND. Contagem dos 10 dias e efeitos do recibo de email: **validação legal obrigatória** — o produto não fecha a disputa jurisprudencial.
31. **Falha técnica de gravação nunca termina a `Reuniao`.** Só intenção humana (`user_end_meeting` / acção equivalente) passa a `ENDED`. Interrupção técnica → segmento com `technical_interrupt`; reunião permanece `IN_PROGRESS` (sub-estado `interrupted` / `idle_open`).
32. **Uma Acta por `Reuniao`; STT consome `RecordingSegment` por ordinal.** Ciclos MediaRecorder são segmentos da mesma reunião, não reuniões novas. Hard-delete pós-`APPROVED` cobre todos os segmentos.