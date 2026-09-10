# 03 — Orquestra LLM

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> **Não implementar antes de existirem tenant + ingestão.**
> Este documento define a arquitectura-alvo para mapear no Miro.

> **Nota v6.1:** Legal Knowledge Base com normas tipadas e versionadas; hierarquia de conflito explícita; LLM jurídico só consultivo; finanças/governação nunca dependem de LLM; Risk Engine **não** aprova Actas (aprovação = domínio / `ResolutionRule` / condóminos); IoT permanece Tier 3 / fora do comercial; Comunicação = única boca; 5 especialidades podem começar como contextos, não 5 pipelines.

## Arquitectura

```
                    ┌───────────────────┐
                    │     MAESTRO       │
                    │  (router + plan)  │
                    └─────────┬─────────┘
                              │ delega
        ┌─────────┬───────────┼───────────┬──────────┐
        ▼         ▼           ▼           ▼          ▼
   ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │Financ.  │ │Jurídico│ │Comunic.│ │Operac. │ │Assembl.│
   │         │ │        │ │        │ │        │ │        │
   │quotas   │ │interpre│ │email   │ │tickets │ │atas    │
   │reconcil.│ │-tação  │ │chat    │ │orçam.  │ │votos   │
   │recibos  │ │legal   │ │notif.  │ │fornec. │ │convoc. │
   │morosos  │ │(consul-│ │portal  │ │        │ │delib.  │
   │         │ │tivo)   │ │        │ │        │ │        │
   └────┬────┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘
        │           │          │          │          │
        └───────────┴──────────┴──────────┴──────────┘
                              │
                    ┌─────────▼─────────┐
                    │  MEMÓRIA ÚNICA    │
                    │  DO PRÉDIO        │
                    │  (isolada/tenant) │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │ BASE DE CONHEC.   │
                    │ PARTILHADA        │
                    │ (genérica, curada,│
                    │  anonimizada)     │
                    └───────────────────┘
                              │
                    ┌─────────▼─────────────────────────┐
                    │  VALIDAÇÃO EM CAMADAS (ver abaixo) │
                    │  Schema → Domain Rules → Legal     │
                    │  (interpretativo) → Risk Engine    │
                    │  (só sobre outputs LLM / ações     │
                    │   candidatas — NÃO aprova Actas)   │
                    └────────────────────────────────────┘
```

## Validação em Camadas — o Jurídico não é o único porteiro

A validação é em camadas, **paralelas, não sequenciais**, e converge num motor determinístico para **outputs do LLM e ações candidatas geradas por IA**:

```
                 Ação candidata gerada por LLM
                 (ex: rascunho de email, Decision Brief, minuta)
                            │
           ┌────────────────┼─────────────────┐
           ▼                ▼                  ▼
     Schema Validation  Domain Rules       Legal Interpretation
     (estrutura OK?)    (determinística)   (LLM Jurídico —
                         limiar,            consultivo: fundamenta
                         AuthorityRule,     e assinala risco;
                         etc.)              NÃO decide sozinho)
           │                │                  │
           └────────────────┼──────────────────┘
                            ▼
                      Risk Engine (determinístico)
                            │
              ┌─────────────┼──────────────┐
              ▼              ▼              ▼
            AUTO         APROVAÇÃO      ESCALAÇÃO
         (confiança    (admin revê     HUMANA/LEGAL
          alta, risco   antes de       (advogado real,
          baixo)        publicar)      não o LLM)
```

**Anti-padrão:** nunca `if (legalAgent.approved) execute()`. O caminho correcto é `Schema → Domain Rules → Policy/Authority/Resolution Rules → Risk Engine → LLM jurídico consultivo quando necessário → humano em risco elevado`.

**Âmbito do Risk Engine (v6.1, explícito):**

- O Risk Engine decide o destino de **outputs LLM** (AUTO / aprovação humana / escalação).
- O Risk Engine **não aprova Actas**. A aprovação de uma Acta é do **domínio**: condóminos, `ResolutionRule` (quórum/maioria), e fluxo de estados da Acta — ver Assembleia abaixo e [02-DOMINIO](02-DOMINIO.md).
- Dinheiro e votos **nunca** são decididos pelo LLM nem pelo Risk Engine no lugar dos órgãos do condomínio.

**Porquê:** uma regra determinística não alucina. O LLM Jurídico dá fundamentação e linguagem; não é gatekeeper único nem substituto da assembleia.

## Legal Knowledge Base

Não é só uma "caixa de leis". Cada norma na base tem metadata obrigatória:

| Campo | Exigência |
|-------|-----------|
| Estatuto da norma | `mandatory` \| `default` \| `configurable` \| `unknown` |
| Versão | Versionada (a lei muda) |
| Data | Entrada em vigor / fim de vigência |
| Jurisdição | Ex.: PT |
| Fonte | Diploma, artigo, proveniência |
| Validade | Vigente / revogada / a confirmar |

**Política de conflito (sempre aplicada, sem o LLM a escolher caso a caso):**

```
lei
  > regulamento (ex.: diploma regulamentar aplicável)
  > regulamento do condomínio
  > deliberações de Assembleia
  > políticas internas LUMEN
```

O regulamento do condomínio pode ser **mais exigente** que a lei, mas **nunca** a contrariar. O LLM jurídico é **só consultivo**: sugere fundamentação e aponta risco; não declara sozinho o que prevalece quando há conflito — a hierarquia acima é código/política, não opinião do modelo.

**Manutenção:** custo operacional contínuo. Expansão a outras jurisdições = bases diferentes.

**Statelessness em re-tentativas:** feedback de rejeição fica isolado ao request/tenant em curso — nunca cacheado como "exemplo" para outro tenant.

## 5 Especialidades + Maestro

Podem começar como **contextos / prompts / tools** sobre a mesma infraestrutura — **não** como cinco pipelines pesados separados. A especialização em agentes distintos cresce quando o volume o justificar. Ver secção "Implementação inicial de F6".

### 1. Financeiro

- **Domínio:** quotas, reconciliação bancária, documentos financeiros (Avisos de Débito, Recibos, Extratos), alertas de morosos, ciclo de vida da `BankConnection`
- **Input:** movimentos bancários, extractos CSV, pagamentos manuais, estado de `BankConnection`
- **Output:** reconciliação (`Payment` candidato), `FinancialDocument` a partir do Ledger, alertas
- **Regra de ouro:** **nunca** responde a factos financeiros (saldo, dívida, valor devido) a partir da Memória Única/RAG. Sempre Ledger via Domain Services (`Obligation` / `Payment` / `Allocation`).
- **Nunca inventa `Obligation`:** só deriva de orçamento/deliberação já aprovados.
- **Linguagem de reconciliação:** "reconciliados / não identificados / a confirmar" — sem acusações definitivas sem prova determinística.
- **Independência de LLM:** o núcleo financeiro **nunca depende** da disponibilidade de um LLM. Ver saldo, recibos e ledger funcionam com o provider em baixo.
- **Transplante:** `reconciliation-engine.ts`, `csv-bank-parser.ts`, `llm-fallback.ts`, `identity-matrix.ts`, `transfer-match.ts` — adaptados a Obligation/Payment/Allocation (ver 02 e 05).
- **Conhecimento partilhável:** heurísticas genéricas. **Nunca:** IBANs, valores exactos, nomes, dívidas.

### 2. Jurídico (camada interpretativa)

- **Papel:** fundamentação legal e avaliação de risco para ações candidatas — **consultivo, não porteiro único**, e **não único gatekeeper** do produto
- **Input:** rascunho de comunicação, proposta de despesa, minuta de acta (para parecer), etc.
- **Output:** fundamentação + score/indicador de risco → alimenta o Risk Engine **quando a ação é output de LLM**; **não** substitui a aprovação de Acta pelos condóminos
- **Regras:** consulta Constituição / Legal Knowledge Base; aplica a política de conflito acima
- **Conhecimento partilhável:** Código Civil, cláusulas-tipo, jurisprudência genérica. **Nunca:** disputas concretas, identidades, regulamento específico de um edifício.

### 3. Comunicação (única boca)

- **Papel:** **toda** comunicação para o exterior passa por aqui — é a única boca do sistema
- **Canais:** email (canal primário obrigatório — envio, retry, estado, observabilidade; **não** “entrega garantida na inbox”), push (best-effort — ver 04-PORTAS), chat portal, SMS (futuro); inclui envio do link de Convite
- **Regra:** nenhum outro módulo envia mensagens directamente
- Passa pela Validação em Camadas quando há relevância jurídica ou financeira
- O Jurídico **revê / aconselha**; **não** é o único que pode "deixar sair" uma mensagem — Schema, Domain Rules e Risk Engine também entram
- **Transplante:** `ticket-email.ts`, `email-llm.ts`
- **Conhecimento partilhável:** templates de tom. **Nunca:** conteúdo real de um tenant.

### 4. Operações

- **Domínio:** tickets, orçamentos, fornecedores, contratos (renovação/aviso prévio), manutenção
- **Princípio:** preparar decisão quase pronta — "supervisionar e aprovar", não "fazer"
- **Fluxo de orçamento (resumo):** pedido → prioridade determinística → cotações → **Decision Brief** (5 perguntas, confiança qualitativa Alta/Média/Baixa, nunca score falso tipo 87/100) → `AuthorityRule` → `Approval` versionada com `scope` explícito
- **Invalidação por alteração material:** se preço/fornecedor/âmbito mudam, a `Approval` antiga não se reaproveita em silêncio
- **Fronteira:** pesquisar/comparar/minutar ≠ assinar contrato ou autorizar pagamento definitivo — isso exige humano
- **Contract:** lembra prazo de aviso; **não** pesquisa mercado nem negocia sozinho ainda (Tier 3)
- **IoT / prédios vizinhos / estacionamento inteligente:** **Tier 3 — Futuro**. Fora do plano comercial (ver [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md)). Não implementar agora.
- **Transplante:** `ticket-llm.ts`, `email-ticket-pipeline.ts`, routes tickets

#### 4.1 Reuniões Admin

- Gravação/transcrição/resumo de reuniões informais (fornecedor, advogado, câmara) — distinto da Assembleia formal
- Visibilidade: admin-only por defeito (`Membership` role Admin)
- Áudio → Whisper → resumo → Memória Única; áudio eliminado após o resumo (prazo exacto com DPO)
- Resumo LLM = **informativo/contextual**, nunca documento probatório
- Pode marcar-se como candidato a assembleia; o módulo Assembleia reutiliza o resumo sem reprocessar áudio

### 5. Assembleia

- **Domínio:** reuniões formais, convocatórias, transcrição, atas, votos, deliberações
- **Independência de LLM:** votar, consultar deliberações e estado da Acta **nunca dependem** do LLM estar disponível
- **Fluxo:**
  1. Convocatória (LLM gera minuta; jurídico consultivo pode rever)
  2. Reunião: áudio → Whisper (chunk 25MB, overlap ~30s + diarização) → transcrição
  3. LLM gera minuta da acta
  4. Quórum/maioria via `ResolutionRule` — nunca hardcoded
  5. Votação: por fração, ponderada por permilagem (domínio, não LLM)
  6. **Aprovação da Acta:** pelos **condóminos** segundo `ResolutionRule` / regras do condomínio — **não** pelo Risk Engine. A deliberação torna-se eficaz com a aprovação (DL 268/94 art. 1.º n.º 3), não com a assinatura
  7. Risk Engine pode validar **apenas** outputs LLM do pipeline (ex.: qualidade/risco da minuta antes de ir a votação) — nunca o "sim" da assembleia
  8. PDF + `hash_aprovada`; presidente assina; presentes subscrevem; estados até `FINAL` com `hash_final_subscrita` (ver diagramas e 02)
- **Assinatura ≠ subscrição:** presidente assina; presentes subscrevem — ver 02-DOMINIO
- **Retenção de áudio:** só durante o pipeline; eliminar após `APPROVED` (confirmar com DPO)
- **Transplante:** `atas-llm.ts`, `reuniao-llm.ts`, `stt.ts`, `ata-pdf.ts`, `reuniao-pdf.ts`

### Maestro

- Router/planeador — decide que especialista(s) activar; **não executa**
- Contexto: Memória Única (tenant) + Base Partilhada
- Implementação futura: function calling / tool use com schema por especialista

### Memória Única do Prédio

- Isolada por tenant; Factual State via Domain Services + Documentos (RAG) + Histórico Operacional
- **Não** inclui saldo/dívida como fonte primária — isso vem do Ledger
- Write só pelo módulo dono do contexto

### Base de Conhecimento Partilhada

- Genérica, curada, anonimizada — leis, faixas de mercado, cláusulas-tipo
- Nunca dados que identifiquem um condomínio ou pessoa

## Decisão de arquitectura: RAG partilhado, não fine-tuning por tenant

Modelos base congelados e partilhados; contexto do tenant via RAG isolado; conhecimento genérico via RAG partilhado. Sem fine-tuning por tenant (custo, RGPD, qualidade por tenant).

## Visão futura (Tier 3 — não implementar agora; fora do comercial)

- Assembly → Project → Procurement → Contract
- Deteção proativa de necessidades
- Renovação com pesquisa de mercado
- Centro de Operações com deteção proativa
- Decision Compression / Autonomy Rate como métricas (eventos desde F0; dashboard não é MVP)
- Benchmarking entre tenants (só com volume)
- **IoT / estacionamento inteligente** — Tier 3 Future; **removido do plano comercial**

## Implementação inicial de F6 — mais simples do que "5 agentes"

```
Intent → Maestro/router → Tool → Domain Service → Policy → Result
```

Os "5 especialistas" começam como contextos diferentes sobre a mesma infra. **O moat não é cinco chamadas LLM — é estado verificável do edifício** (Ledger, AuditEvent, Membership) e execução com confiança. Ver também Tenant Exit / portabilidade em [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md).

## Princípios

1. Cada especialidade é stateless — estado na Memória Única (tenant) e na Base Partilhada
2. Validação em camadas, não um único porteiro jurídico
3. Comunicação é o único canal de saída
4. Maestro não executa — só planeia e delega
5. Isolamento por tenant é inviolável
6. RAG nunca é fonte de verdade financeira
7. Custo de tokens é risco técnico secundário; risco nº1 de negócio = aquisição (ver 07 / 08)
8. Acesso nunca por QR físico ou token sem Membership
9. **Núcleo financeiro e de governação nunca depende da disponibilidade de um LLM**
10. Aprovação ≠ assinatura/subscrição; eficácia da deliberação = aprovação da Acta
11. **Risk Engine não aprova Actas**; LLM nunca decide dinheiro nem votos
12. Legal Knowledge Base versionada + política de conflito lei > … > políticas LUMEN
