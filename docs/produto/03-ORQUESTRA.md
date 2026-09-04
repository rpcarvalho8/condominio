# 03 — Orquestra LLM

> **Não implementar antes de existirem tenant + ingestão.**
> Este documento define a arquitectura-alvo para mapear no Miro.

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
   │quotas   │ │validar │ │email   │ │tickets │ │atas    │
   │reconcil.│ │saídas  │ │chat    │ │orçam.  │ │votos   │
   │recibos  │ │conform.│ │notif.  │ │fornec. │ │convoc. │
   │morosos  │ │contratos│ │portal │ │IoT     │ │delib.  │
   └────┬────┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘
        │           │          │          │          │
        └───────────┴──────────┴──────────┴──────────┘
                              │
                    ┌─────────▼─────────┐
                    │  MEMÓRIA ÚNICA    │
                    │  DO PRÉDIO        │
                    │                   │
                    │ • constituição    │
                    │ • histórico fin.  │
                    │ • tickets/obras   │
                    │ • atas/delib.     │
                    │ • fornecedores    │
                    │ • comunicações    │
                    └───────────────────┘
```

## 5 Especialidades + Maestro

### 1. Financeiro
- **Domínio:** quotas, reconciliação bancária, recibos, morosos, relatórios
- **Input:** movimentos bancários, extractos CSV, pagamentos manuais
- **Output:** reconciliação, recibos PDF, alertas morosos
- **Transplante da dev:** `reconciliation-engine.ts`, `csv-bank-parser.ts`, `llm-fallback.ts`, `identity-matrix.ts`, `transfer-match.ts`, cascata de amortização

### 2. Jurídico (Porteiro)
- **Papel:** valida tudo o que SAI — emails, chats, actas, contratos, movimentos de dinheiro
- **Não é:** porteiro de cada ecrã; é porteiro do que o condomínio diz e gasta
- **Input:** rascunho de comunicação, proposta de despesa, acta para aprovar
- **Output:** aprovado/rejeitado + fundamentação legal (artigos CC, regulamento)
- **Regras:** consulta Constituição, verifica conformidade com regulamento interno

### 3. Comunicação (Única Boca)
- **Papel:** toda comunicação para o exterior passa por aqui
- **Canais:** email, chat portal, notificações push, SMS (futuro)
- **Regra:** nenhum outro módulo envia mensagens directamente
- **Jurídico revê** antes de enviar (quando relevância jurídica)
- **Transplante da dev:** `ticket-email.ts`, `email-llm.ts`

### 4. Operações
- **Domínio:** tickets, orçamentos, fornecedores, manutenção, IoT
- **Fluxo de Orçamento:**
  1. Condómino ou admin cria pedido: área, tipo, descrição, urgência
  2. Sistema pede 3 cotações: 3 fornecedores conhecidos + 2 do mercado
  3. SLA: 4h se urgente
  4. Parecer automático ao admin
  5. Se > limiar → assembleia adjudica
- **IoT/prédios vizinhos:** estacionamento inteligente (módulo futuro)
- **Transplante da dev:** `ticket-llm.ts`, `email-ticket-pipeline.ts`, routes tickets

### 5. Assembleia
- **Domínio:** reuniões, convocatórias, transcrição áudio, atas, votos, deliberações
- **Fluxo:**
  1. Convocatória (LLM gera, Jurídico revê)
  2. Reunião: áudio → Whisper STT (chunk 25MB) → transcrição
  3. LLM gera acta a partir da transcrição
  4. Votação: por fração, ponderada por permilagem
  5. Acta final: Jurídico valida, admin publica
- **Transplante da dev:** `atas-llm.ts`, `reuniao-llm.ts`, `stt.ts` (Whisper chunks), `ata-pdf.ts`, `reuniao-pdf.ts`

### Maestro
- **Papel:** router inteligente — recebe input, decide qual(is) especialista(s) activar
- **Não é:** um super-LLM que faz tudo; é um planeador
- **Contexto:** acede à Memória Única para decisão informada
- **Implementação futura:** function calling / tool use com schema por especialista

### Memória Única do Prédio
- **O quê:** base de conhecimento partilhada por todas as especialidades
- **Conteúdo:** constituição + histórico financeiro + tickets + atas + fornecedores + comunicações
- **Isolamento:** 1 memória por tenant (1 BD por condomínio)
- **Acesso:** read para todas as especialidades; write só pelo módulo dono do contexto

## Princípios

1. **Cada especialidade é stateless** — estado vive na Memória Única
2. **Jurídico não bloqueia UI** — valida outputs, não inputs de ecrã
3. **Comunicação é o único canal** — nenhum módulo envia email/chat directamente
4. **Maestro não executa** — só planeia e delega
5. **Custo de tokens é risco nº1** — cada chamada LLM deve ter justificação
