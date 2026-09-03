# 08 — Plano Financeiro (Risco nº1 = Custo de Tokens)

## Custo de Tokens LLM — Análise Detalhada

### Modelos usados (actual na dev)

| Uso | Modelo | Provider | Custo input | Custo output |
|-----|--------|----------|-------------|--------------|
| Reconciliação fallback | Llama 3 70B | Groq | $0.59/M tok | $0.79/M tok |
| Tickets triagem | Llama 3 70B | Groq | $0.59/M tok | $0.79/M tok |
| Atas | Llama 3 70B | Groq | $0.59/M tok | $0.79/M tok |
| Email triagem | Llama 3 70B | Groq | $0.59/M tok | $0.79/M tok |
| STT (áudio) | Whisper Large V3 Turbo | Groq | $0.006/min | — |
| Fallback LLM | Various | OpenRouter | Variável | Variável |

### Custo estimado por condomínio/mês (20 frações)

| Operação | Frequência/mês | Tokens/chamada | Custo/mês |
|----------|----------------|----------------|-----------|
| Reconciliação LLM (fallback) | ~10 transações | ~2K tok | $0.03 |
| Recibos (sem LLM) | 20 | 0 | $0.00 |
| Tickets triagem | ~5 | ~1K tok | $0.01 |
| Email triagem | ~15 | ~1K tok | $0.02 |
| Fecho de mês (sem LLM) | 1 | 0 | $0.00 |
| Ata mensal/trimestral | 0.3 | ~5K tok | $0.003 |
| Transcrição áudio (30 min) | 0.3 | — | $0.054 |
| **Total sem orquestra** | | | **~$0.12/mês** |

### Custo com Orquestra LLM (F6)

| Operação | Frequência/mês | Tokens/chamada | Custo/mês |
|----------|----------------|----------------|-----------|
| Maestro routing | ~50 | ~500 tok | $0.04 |
| Financeiro especialista | ~30 | ~2K tok | $0.05 |
| Jurídico validação | ~20 | ~3K tok | $0.06 |
| Comunicação geração | ~15 | ~2K tok | $0.03 |
| Operações (orçamentos) | ~10 | ~3K tok | $0.03 |
| Assembleia (delib.) | ~3 | ~4K tok | $0.01 |
| **Total com orquestra** | | | **~$0.34/mês** |

### Custo de BD (Turso)

| Item | Custo/tenant/mês |
|------|-----------------|
| Turso Starter (500 DBs incluídas) | $29/mês total = ~$0.06/tenant (500 tenants) |
| Turso Scaler (10K DBs) | $79/mês total = ~$0.008/tenant |

### Infra

| Item | Custo/mês |
|------|-----------|
| Fly.io / Railway (2 VMs) | ~$20 |
| Domínio + DNS | ~$1 |
| Turso (Starter) | $29 |
| Groq API (free tier: 14.4K req/dia) | $0 (fase piloto) |
| **Total fixo** | **~$50/mês** |

## Projecção Financeira

### Cenário: 200 condomínios no fim do Y1

| Item | Mensal | Anual |
|------|--------|-------|
| **Receita** (200 × 44€ avg) | 8.800€ | 105.600€ |
| Custo tokens LLM (200 × $0.34) | -62€ | -744€ |
| Custo Turso | -29€ | -348€ |
| Custo infra | -50€ | -600€ |
| Enable Banking (se aplicável) | -0€ (pass-through) | — |
| **Margem bruta** | **8.659€** | **103.908€** |
| **Margem %** | **98.4%** | |

### Cenário: 2.000 condomínios (Y3)

| Item | Mensal | Anual |
|------|--------|-------|
| Receita (2000 × 44€) | 88.000€ | 1.056.000€ |
| Tokens LLM (2000 × $0.50) | -910€ | -10.920€ |
| Turso Scaler | -79€ | -948€ |
| Infra (4 VMs) | -80€ | -960€ |
| Suporte (1 FTE) | -2.000€ | -24.000€ |
| **Margem bruta** | **84.931€** | **1.019.172€** |
| **Margem %** | **96.5%** | |

## Mitigação do Risco nº1 (Custo de Tokens)

### Estratégias

1. **Cache de respostas LLM** — mesmas perguntas (e.g., "esta transação é de quem?") em condomínios similares
2. **Modelos menores para tarefas simples** — triagem de tickets não precisa de 70B; 8B basta
3. **Rate limiting por tenant** — plano Essencial = 100 chamadas LLM/mês; acima = pay-per-use
4. **Batch processing** — reconciliação em batch (não 1 a 1) reduz overhead de tokens
5. **Prompts optimizados** — system prompt partilhado (cached no Groq), input mínimo
6. **Fallback para regras** — se confiança da regra > 95%, não chamar LLM
7. **Monitoring** — dashboard de custo por tenant, alertas quando > threshold

### Breakeven por tenant

| Plano | Preço/mês | Custo variável/mês | Margem |
|-------|-----------|--------------------:|--------|
| Essencial (29€) | 29€ | ~$0.15 (€0.14) | 99.5% |
| Profissional (59€) | 59€ | ~$0.35 (€0.32) | 99.5% |
| Enterprise (99€) | 99€ | ~$0.50 (€0.46) | 99.5% |

**Conclusão:** o custo de tokens é um risco teórico mas na prática é desprezável com os preços actuais do Groq. O risco real é se houver necessidade de migrar para modelos OpenAI/Anthropic (10–30× mais caros). Mitigação: manter compatibilidade com múltiplos providers.

## Investimento Inicial

| Item | Valor |
|------|-------|
| Desenvolvimento (founder time, 6 meses) | €0 (sweat equity) |
| Infra + APIs (6 meses) | ~€300 |
| Legal (consulta RGPD + termos) | ~€500 |
| Domínio + branding | ~€100 |
| **Total para MVP** | **~€900** |
