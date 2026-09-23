# 08 — Plano Financeiro (esqueleto auditável)

> **Versão: v7.0 | Data: 2026-09-23 | Estado: ACEITE (reconciliação empresarial)**

> Documento esqueleto. Células `TBD` são intencionais. Não inventar taxas de conversão, CAC fechados, nem SOM Y1/Y3 até o piloto os medir.  
> Narrativa comercial: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md). Modelo de valor: [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md). Evidência operacional: [PROOF-SHEET](PROOF-SHEET.md).

> **Nota v7.0:** formaliza Unit Economics com a fórmula completa; marca 29€ como hipótese de preço do piloto; adiciona cenários conservador/base/expansão com células TBD. Não substitui disciplina por forecast inventado.

## Princípios deste plano

1. Risco nº1 = aquisição de clientes, não custo de tokens.
2. Não usar CAC institucional (APEGAC/ANACON, administradoras, imobiliárias com conflito) como premissa financeira — no máximo experiência sem número modelado (ADR-019, ADR-045).
3. SAM = hipótese não validada; SOM Y1/Y3 = TBD pós-piloto.
4. Não projectar ARR a partir de "50.000 × 44€" como mercado endereçável.
5. Validação de negócio: 5 → 20 → 40 tenants com CAC e win-rate medidos.
6. No piloto vende-se só Essencial (**29€/mês = hipótese de preço**, não preço demonstrado como óptimo). Profissional/Enterprise fora do modelo até gates (ver 07).
7. Trabalho humano de transição/onboarding é linha de custo de primeira classe — não amortizar por LTV ainda não observado.

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
| Tokens LLM (uso típico Essencial) | ordem de grandeza &lt; €0,50/tenant/mês | Secundário; validar com logs reais pós-piloto |
| Whisper (se usado) | pass-through + margem (ver 07) | Só com atas/reuniões |
| Enable Banking (se add-on activo) | custo API fornecedor + margem | Validar com fornecedor |
| Storage / egress por tenant | TBD | |
| Suporte humano (minutos × custo/hora) | TBD | Crítico no piloto assisted |
| Onboarding / transição (horas × custo) | TBD | Objecto central de validação (PROOF-SHEET) |
| **Custo variável médio / tenant / mês** | **TBD** | |

Tokens são linha a monitorizar, não o driver do runway nem o risco nº1.

### Medição da entrega e contribuição

Registar por condomínio e ciclo: € efectivamente pagos, receita líquida atribuível ao serviço, horas de onboarding, minutos de operação/suporte, número e tempo das excepções, erros, retrabalho, operações concluídas, utilização do resultado e renovação paga. Identificar separadamente comprador autorizado e utilizador.

- Receita líquida: excluir IVA cobrado, descontos e reembolsos.
- Custo de entrega: trabalho humano, fornecedores e restantes custos directamente atribuíveis ao ciclo.
- Contribuição do ciclo: receita líquida menos custo de entrega.
- Onboarding e aquisição: custos iniciais separados; não os amortizar por uma duração de cliente ainda não observada.
- Tempo do founder: mostrar custo de caixa e custo económico de remunerar/substituir esse trabalho; trabalho não remunerado não é margem.
- Minutos humanos: separar empresa, cliente e profissionais externos. Mostrar dispersão e causas de excepção, não apenas a média.
- Renovação: intenção declarada não equivale a novo ciclo pago e utilizado.

Os valores continuam TBD até existirem registos reais. Um primeiro pagamento valida uma transacção, não retenção nem economia sustentável.

## 3. Unit Economics (fórmula canónica)

```text
Receita líquida (por condomínio / ciclo)
− custo humano (onboarding + operação + suporte + excepções)
− infraestrutura atribuível
− IA / tokens
− serviços externos (banking, STT, …)
− suporte residual
= contribuição por condomínio
```

| Componente | Valor | Nota |
|------------|------:|------|
| Preço lista Essencial | 29€/mês | Hipótese de piloto |
| Preço efectivo (descontos) | TBD | −30% só em early adopters após regra de capacidade |
| Receita líquida | TBD | Após IVA/descontos/reembolsos |
| Custo humano | TBD | Principal incerteza no piloto |
| Infra + IA + externos | TBD | |
| **Contribuição** | **TBD** | Não inventar |

Fórmulas auxiliares (quando houver dados):

```
contribuição_mensal = receita_líquida_mensal − custo_entrega_mensal
payback_meses       ≈ CAC / contribuição_mensal
margem_contribuição = contribuição_mensal / receita_líquida_mensal
```

## 4. Receita unitária (piloto)

| Plano | Preço lista | No piloto | Contribuição bruta / mês |
|-------|------------:|-----------|--------------------------|
| Essencial | 29€ (hipótese) | Único vendável | 29€ − variável TBD |
| Profissional | 59€ | Fora até F5 + gates | — |
| Enterprise | 99€ | Fora até F6 (Y1+) | — |
| Add-ons | ver 07 | Opcional | TBD |

Preço de lançamento (−30%) só na fase early adopters após regra de capacidade (07) — não misturar com SOM de pitch.

## 5. Grelha de CAC por canal directo

Preencher só com dados observados. Canais institucionais excluídos desta grelha.

| Canal | Leads / mês | Custo canal / mês | CAC (custo ÷ tenants pagos) | Win-rate (voto sim ÷ leads que chegaram a assembleia) | Time to assembly (dias) | Drop-off before vote | Notas |
|-------|------------:|------------------:|----------------------------:|-----------------------------------------------------:|------------------------:|---------------------:|-------|
| Facebook / WhatsApp (grupos locais) | TBD | TBD | TBD | TBD | TBD | TBD | Hiperlocal |
| Condómino-embaixador | TBD | TBD (crédito / meses grátis) | TBD | TBD | TBD | TBD | Clustering geográfico |
| Notário / construtora (constituição PH) | TBD | TBD | TBD | TBD | TBD | TBD | Sem conflito de administradora |
| Lead magnet relatório (modo A self-serve) | TBD | TBD | TBD | TBD | TBD | TBD | Quando F1/F2 maduros |
| Lead magnet relatório (modo B assisted) | ≤4/mês | tempo founder | TBD | TBD | TBD | TBD | Cap duro de capacidade |
| Administradora profissional (experimento) | — | — | Não modelar até evidência | — | — | — | Hipótese ADR-045; fora do modelo base |
| Institucional (APEGAC/ANACON, etc.) | — | — | Não modelar | — | — | — | Só experiência; ver 07 |

Fórmulas (quando houver dados):

```
CAC_canal = custo_atribuído_canal / nº_tenants_pagos_origem_canal
win_rate  = deliberações_favoráveis / assembleias_com_voto_adopção
payback_meses ≈ CAC / contribuição_bruta_mensal_por_tenant
```

## 6. Payback e runway (fórmulas com TBD)

| Indicador | Fórmula | Valor |
|-----------|---------|------:|
| Contribuição bruta / tenant / mês | preço_efectivo − custo_variável | TBD |
| Payback (meses) | CAC ÷ contribuição_bruta | TBD |
| Burn mensal | fixos + variáveis×N + CAC_spend − receita | TBD |
| Runway (meses) | caixa_disponível ÷ burn_mensal (se burn &gt; 0) | TBD |
| Break-even N tenants | resolver receita(N) ≥ custos(N) | TBD |

Não preencher com cenários optimistas inventados. Actualizar após cada patamar 5 / 20 / 40.

## 7. Cenários (estrutura — valores TBD)

Usar a mesma grelha nos três cenários. **Não** preencher com ficção; só dados observados ou placeholders explícitos.

| Variável | Conservador | Base | Expansão |
|----------|------------:|-----:|---------:|
| Preço efectivo Essencial | TBD | TBD (lista 29€) | TBD |
| N tenants pagos (fim Y1) | TBD | TBD | TBD |
| CAC médio | TBD | TBD | TBD |
| Win-rate | TBD | TBD | TBD |
| Horas humanas / tenant / mês | TBD | TBD | TBD |
| % assisted vs self-serve | TBD | TBD | TBD |
| Contribuição / tenant / mês | TBD | TBD | TBD |
| SOM Y1 | TBD | TBD | TBD |
| SOM Y3 | TBD | TBD | TBD |

Conservador assume assistência alta e aquisição lenta; expansão só depois de self-serve e custo de entrega conhecido (regras de gestão em 07).

## 8. Mercado (células SOM)

| | Condomínios | ARR | Estatuto |
|---|------------:|----:|----------|
| TAM | ~500.000 | — | Macro; não acionável |
| SAM | ~50.000 (hipótese) | não calcular como se fosse endereço | Hipótese não validada |
| SOM Y1 | TBD pós-piloto | TBD | Só após CAC/win-rate medidos |
| SOM Y3 | TBD pós-piloto | TBD | Idem |

Critério de validação (07): 5 → 20 → 40 com medição — substitui metas de pitch.

## 9. O que este documento proíbe explicitamente

- Usar CAC institucional como base do modelo
- Inventar conversão "X% dos 50.000"
- Tratar IoT como linha de receita Y1
- Vender Profissional/Enterprise no modelo do piloto
- Apresentar custo de tokens como risco financeiro principal
- Tratar 29€ como preço óptimo demonstrado
- Contar trabalho não remunerado do founder como margem positiva
- Preencher cenários conservador/base/expansão com números sem origem observada

## 10. Ligação à narrativa

Posicionamento, funil, capacidade, pricing e riscos: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md).  
Cadeia de valor e hipóteses: [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md).  
Custo de entrega observado: [PROOF-SHEET](PROOF-SHEET.md).  

Este ficheiro só guarda números auditáveis e o sítio onde os TBDs serão preenchidos.
