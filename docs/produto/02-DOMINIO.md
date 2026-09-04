# 02 — Domínio (Bounded Contexts)

## Glossário

| Termo | Definição |
|-------|-----------|
| **Tenant** | Um condomínio = 1 base de dados isolada |
| **Fração** | Unidade autónoma (apartamento, loja, garagem) |
| **Permilagem** | Quota-parte (‰) da fração no total do prédio |
| **Quota** | Valor mensal/extra que o proprietário deve |
| **Rubrica** | Categoria de despesa (CC, elevador, obras…) |
| **Cascata** | Amortização de pagamento: CC → extras → dívidas antigas |
| **Reconciliação** | Matching banco ↔ frações (matriz identidade + LLM fallback) |
| **Acta** | Documento legal de assembleia, com deliberações e votos |
| **Ticket** | Pedido de condómino (avaria, reclamação, sugestão) |
| **Orçamento** | Pedido de cotação para obra/serviço |

## Bounded Contexts

```
┌──────────────────────────────────────────────────────────────┐
│                        TENANT (1 BD)                         │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Constituição │  │  Financeiro  │  │   Operações      │   │
│  │              │  │              │  │                  │   │
│  │ • frações    │  │ • quotas     │  │ • tickets        │   │
│  │ • permilagem │  │ • despesas   │  │ • orçamentos     │   │
│  │ • reg.interno│  │ • banco      │  │ • fornecedores   │   │
│  │ • contactos  │  │ • reconcil.  │  │ • manutenção     │   │
│  │ • IBANs      │  │ • recibos    │  │ • IoT (futuro)   │   │
│  └──────┬───────┘  │ • cascata    │  └────────┬─────────┘   │
│         │          │ • morosos    │           │              │
│         │          │ • relatórios │           │              │
│         │          └──────┬───────┘           │              │
│         │                 │                   │              │
│  ┌──────▼─────────────────▼───────────────────▼──────────┐  │
│  │              Memória Única do Prédio                   │  │
│  │  (factos, histórico, contexto para todas as LLMs)      │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │                    ORQUESTRA                           │  │
│  │  Maestro + 5 Especialistas LLM                        │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │   Comunicação (única boca) + Jurídico (porteiro)      │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Entidades principais

### Constituição
- `Condominio` — morada, NIF, IBAN, regulamento_pdf_url
- `Fracao` — número, tipo, proprietário, permilagem, quota_mensal
- `Proprietario` — nome, NIF, email, telefone, frações[]
- `RegulamentoInterno` — texto_parsed, regras[], penalizações[]

### Financeiro
- `Quota` — fração, mês, ano, tipo (CC/elevador/obras/…), valor, pago, data_pagamento
- `Despesa` — descrição, categoria, valor, data, fornecedor, recorrente
- `MovimentoBancario` — data, valor, descritivo, IBAN_origem, reconciliado, fração_match
- `Recibo` — fração, mês, ano, pdf_url, enviado
- `Relatorio` — mês, ano, receitas, despesas, saldo

### Operações
- `Ticket` — fração_origem, assunto, descrição, fotos[], estado, prioridade
- `Orcamento` — area, tipo, descrição, urgência, cotações[3], fornecedores[5], SLA
- `Fornecedor` — nome, NIF, categoria, avaliação, histórico
- `Acta` — reunião, texto, deliberações[], votos[], aprovada

### Assembleia
- `Reuniao` — data, convocatória, áudio_url, transcricao, acta
- `Deliberacao` — assunto, tipo_votacao, resultado, votos[]
- `Voto` — fração, sentido (sim/não/abstenção), permilagem

## Invariantes de Domínio

1. Σ permilagens = 1000‰
2. Quota CC mensal = orçamento_anual × (permilagem / 1000) / 12
3. Pagamento aplica cascata: CC do mês → extras pendentes → dívidas antigas
4. Acta só é válida com quórum (>50% permilagem em 1ª conv, qualquer em 2ª)
5. Orçamento > limiar → assembleia adjudica (não admin sozinho)
