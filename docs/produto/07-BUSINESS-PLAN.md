# 07 — Esqueleto de Business Plan

## Proposta de Valor

**BuildingMind** — gestão inteligente de condomínios com IA.

| Para quem | Problema | Solução |
|-----------|----------|---------|
| Administradores profissionais | Gestão manual repetitiva, erros humanos, comunicação fragmentada | Automação financeira, comunicação centralizada, IA que sugere e valida |
| Administradores não-profissionais (condóminos-admin) | Complexidade legal, falta de tempo, ferramentas inadequadas | Setup guiado, IA jurídica, QR para condóminos |
| Condóminos | Falta de transparência, dificuldade em reportar problemas | Portal QR instantâneo, tickets com foto, votação digital |

## Modelo de Receita

### SaaS — preço por condomínio/mês

| Plano | Frações | Preço/mês | Inclui |
|-------|---------|-----------|--------|
| **Essencial** | até 20 | 29€ | Financeiro + portal QR + recibos |
| **Profissional** | até 50 | 59€ | + Orçamentos + atas + votação |
| **Enterprise** | ilimitado | 99€ | + Orquestra LLM + IoT + API |

### Add-ons

| Add-on | Preço |
|--------|-------|
| Enable Banking (sync automático) | +9€/mês |
| Transcrição áudio (Whisper) | €0.006/min (pass-through + 20%) |
| LLM avançado (orçamentos, atas) | €0.01/request (pass-through + 30%) |

## Mercado

### Portugal
- ~500.000 condomínios
- ~3.000 administradores profissionais
- ~50.000 condóminos-admin (autogestão)

### TAM/SAM/SOM (estimativa)
| | Condomínios | ARR |
|---|------------|-----|
| TAM | 500.000 × 44€ avg | 264M€/ano |
| SAM | 50.000 (urbanos, >10 frações) | 26M€/ano |
| SOM Y1 | 200 | 106K€/ano |
| SOM Y3 | 2.000 | 1.06M€/ano |

## Go-to-Market

### Fase 1: Piloto (Y1 Q1–Q2)
- 5 condomínios beta gratuitos (incluindo Urbanização da Fonte)
- Validar fluxo completo end-to-end
- Iterar com feedback real

### Fase 2: Early Adopters (Y1 Q3–Q4)
- Preço de lançamento (-30%)
- Canal: administradores profissionais (1 admin ≈ 30–100 condomínios)
- Parcerias com associações (APEGAC, ANACON)

### Fase 3: Crescimento (Y2+)
- Preço normal
- Self-service onboarding (ingestão guiada)
- Marketplace de fornecedores por zona
- Expansão para Espanha / Brasil

## Vantagem Competitiva

| Factor | BuildingMind | Software tradicional |
|--------|-------------|---------------------|
| Setup | Upload PDF → pronto | Inserção manual de dados |
| Acesso condómino | QR scan → portal | App a instalar / email PDF |
| Reconciliação | Automática (banco + IA) | Manual |
| Comunicação | Centralizada + revista juridicamente | Cada módulo envia para lado |
| Atas | Áudio → transcrição → acta automática | Escrita manual |
| Orçamentos | 3 cotações automáticas | Admin liga a fornecedores |

## Equipa Necessária (Fase 1)

| Papel | FTE |
|-------|-----|
| Founder / Product + Dev | 1 (existente) |
| Frontend / Design | 0.5 (freelance) |
| Legal advisor | 0.1 (consultoria pontual) |

## Riscos

| # | Risco | Mitigação |
|---|-------|-----------|
| 1 | **Custo de tokens LLM** | Ver [Plano Financeiro](08-PLANO-FINANCEIRO.md) |
| 2 | Adopção lenta (inércia do sector) | Piloto gratuito, ROI demonstrável |
| 3 | Concorrência (e.g. Condomínio Digital, Habitak) | Diferenciação pela IA e QR |
| 4 | Regulamentação RGPD | Dados em EU, consent explícito, isolamento por tenant |
| 5 | Dependência de APIs externas (Enable Banking, Groq) | Fallbacks (CSV manual, OpenRouter) |
