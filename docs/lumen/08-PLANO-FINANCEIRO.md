# 08 — Plano Financeiro (esqueleto auditável)

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> **Documento esqueleto.** Células `TBD` são intencionais. **Não inventar taxas de conversão, CAC fechados, nem SOM Y1/Y3** até o piloto os medir. Narrativa comercial e funil: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md).

## Princípios deste plano

1. **Risco nº1 = aquisição de clientes**, não custo de tokens.
2. **Não usar CAC institucional** (APEGAC/ANACON, administradoras, imobiliárias com conflito) como premissa financeira — no máximo experiência sem número modelado.
3. **SAM** = hipótese não validada; **SOM Y1/Y3** = TBD pós-piloto.
4. **Não** projectar ARR a partir de "50.000 × 44€" como mercado endereçável.
5. Validação de negócio: **5 → 20 → 40** tenants com CAC e win-rate **medidos**.
6. No piloto vende-se **só Essencial** (29€/mês). Profissional/Enterprise fora do modelo até gates (ver 07).

## 1. Custos fixos (placeholders)

| Rubrica | €/mês | Fonte / nota |
|---------|------:|--------------|
| Infra cloud (Fly/Railway + object storage) | TBD | Medir após F0 |
| Turso / BDs (platform + N tenants) | TBD | Escala com N; provisionamento F0 |
| Domínio, email transaccional, monitorização | TBD | |
| Ferramentas (repo, CI, design) | TBD | |
| Legal / DPO (retainer pontual amortizado) | TBD | Antes de Production Gates |
| Seguro (empresa / RC — se existir) | TBD | RC admin = add-on a validar (07) |
| Outros fixos | TBD | |
| **Total fixo mensal** | **TBD** | Actualizar com facturas reais |

## 2. Custo variável por tenant

| Rubrica | Estimativa | Fonte / nota |
|---------|------------|--------------|
| Tokens LLM (uso típico Essencial) | ordem de grandeza &lt; €0,50/tenant/mês | **Secundário**; validar com logs reais pós-piloto; OpenRouter/Groq pricing |
| Whisper (se usado) | pass-through + margem (ver 07) | Só com atas/reuniões |
| Enable Banking (se add-on activo) | custo API fornecedor + margem | Validar com fornecedor |
| Storage / egress por tenant | TBD | |
| Suporte humano (minutos × custo/hora) | TBD | Crítico no piloto assisted |
| **Custo variável médio / tenant / mês** | **TBD** | |

> Tokens são linha de custo a monitorizar, **não** o driver do runway nem o risco nº1.

## 3. Receita unitária (piloto)

| Plano | Preço lista | No piloto | Contribuição bruta / mês |
|-------|------------:|-----------|--------------------------|
| Essencial | 29€ | Único vendável | 29€ − variável TBD |
| Profissional | 59€ | Fora até F5 + gates | — |
| Enterprise | 99€ | Fora até F6 (Y1+) | — |
| Add-ons | ver 07 | Opcional | TBD |

Preço de lançamento (−30%) só na fase early adopters **após** regra de capacidade (07) — não misturar com SOM de pitch.

## 4. Grelha de CAC por canal directo

Preencher só com dados observados. Canais institucionais **excluídos** desta grelha.

| Canal | Leads / mês | Custo canal / mês | CAC (custo ÷ tenants pagos) | Win-rate (voto sim ÷ leads que chegaram a assembleia) | Time to assembly (dias) | Drop-off before vote | Notas |
|-------|------------:|------------------:|----------------------------:|-----------------------------------------------------:|------------------------:|---------------------:|-------|
| Facebook / WhatsApp (grupos locais) | TBD | TBD | TBD | TBD | TBD | TBD | Hiperlocal |
| Condómino-embaixador | TBD | TBD (crédito / meses grátis) | TBD | TBD | TBD | TBD | Clustering geográfico |
| Notário / construtora (constituição PH) | TBD | TBD | TBD | TBD | TBD | TBD | Sem conflito de administradora |
| Lead magnet relatório (modo A self-serve) | TBD | TBD | TBD | TBD | TBD | TBD | Quando F1/F2 existirem |
| Lead magnet relatório (modo B assisted) | ≤4/mês | tempo founder | TBD | TBD | TBD | TBD | Cap duro de capacidade |
| Institucional (APEGAC/ANACON, etc.) | — | — | **Não modelar** | — | — | — | Só experiência; ver 07 |

**Fórmulas (quando houver dados):**

```
CAC_canal = custo_atribuído_canal / nº_tenants_pagos_origem_canal
win_rate  = deliberações_favoráveis / assembleias_com_voto_adopção
payback_meses ≈ CAC / contribuição_bruta_mensal_por_tenant
```

## 5. Payback e runway (fórmulas com TBD)

| Indicador | Fórmula | Valor |
|-----------|---------|------:|
| Contribuição bruta / tenant / mês | preço_efectivo − custo_variável | TBD |
| Payback (meses) | CAC ÷ contribuição_bruta | TBD |
| Burn mensal | fixos + variáveis×N + CAC_spend − receita | TBD |
| Runway (meses) | caixa_disponível ÷ burn_mensal (se burn &gt; 0) | TBD |
| Break-even N tenants | resolver receita(N) ≥ custos(N) | TBD |

Não preencher com cenários optimistas inventados. Actualizar após cada patamar 5 / 20 / 40.

## 6. Mercado (células SOM)

| | Condomínios | ARR | Estatuto |
|---|------------:|----:|----------|
| TAM | ~500.000 | — | Macro; não acionável |
| SAM | ~50.000 (hipótese) | **não calcular como se fosse endereço** | Hipótese não validada |
| SOM Y1 | **TBD pós-piloto** | **TBD** | Só após CAC/win-rate medidos |
| SOM Y3 | **TBD pós-piloto** | **TBD** | Idem |

Critério de validação (07): **5 → 20 → 40** com medição — substitui metas de pitch.

## 7. O que este documento proíbe explicitamente

- Usar CAC institucional como base do modelo
- Inventar conversão "X% dos 50.000"
- Tratar IoT como linha de receita Y1
- Vender Profissional/Enterprise no modelo do piloto
- Apresentar custo de tokens como risco financeiro principal

## 8. Ligação à narrativa

Tudo o que é posicionamento, funil deliberativo, capacidade, pricing e riscos de negócio está em [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md). Este ficheiro só guarda números auditáveis e o sítio onde os TBDs serão preenchidos.
