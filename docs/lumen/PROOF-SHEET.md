# PROOF-SHEET — Business → Product → Operational Evidence

> **Versão: v7.0 | Data: 2026-09-23 | Estado: VIVO (actualizar após cada trial)**

> Matriz de honestidade comercial. Precedência para conflito **só de negócio**: evidência neste ficheiro > narrativa em `10` / `07` / `08` / `11`.  
> Precedência técnica inalterada: ADR-LOG > 02-DOMINIO > 06-FATIAS > diagramas > resto ([00-INDICE](00-INDICE.md)).  
> Estado documental ≠ estado operacional ≠ validação de negócio.

---

## Como ler

| Estatuto | Significado |
|----------|-------------|
| **Demonstrado** | Evidência operacional repetível + (quando aplicável) pagamento/renovação |
| **Parcial** | Recorte de produto existe; operação comercial ou ponta-a-ponta em falta |
| **Não operacional** | Spec ou código insuficiente para uso real no piloto |
| **Futuro** | Fora do horizonte de venda actual (freeze / Tier 3) |
| **Não demonstrado** | Capacidade de negócio reclamável só após prova |

Camadas de pergunta (07): Estratégia | Negócio | Produto | Operação | Economia.

---

## Matriz Business → Product → Evidence

| Capacidade de negócio | Produto / fatia | Evidência actual | Estatuto |
|-----------------------|-----------------|------------------|----------|
| Plataforma multi-tenant + auth | F0 | Kernel/platform em evolução; ver README / auditorias | Parcial |
| Constituição (fracções, permilagem) | F1 | [F1-IMPLEMENTACAO](F1-IMPLEMENTACAO.md); pipeline ADR-043; confirmação linha a linha; upload max **10MB** | Parcial |
| Importação / Data-to-State | F1 | Perfis ADR-044; `needs_human_review` bloqueia lote; LLM hipótese não autoritativa | Parcial |
| Financeiro (Ledger) | F2 | [F2-IMPLEMENTACAO](F2-IMPLEMENTACAO.md): kernel + testes; **não** F2 ponta-a-ponta; **sem** cutover Fonte; **sem** negócio validado | Parcial |
| Portal + convites + tickets | F3 | [F3-IMPLEMENTACAO](F3-IMPLEMENTACAO.md); PWA; push iOS **FRAGILE**; depende de constituição/contactos/memberships reais | Parcial |
| Ops avançadas | F4 | Spec em 06; freeze comercial no piloto | Futuro (freeze) |
| Governance (voto, acta) | F5 | Fora do piloto Essencial | Não operacional |
| Orquestra LLM | F6 | Spec em 03; ADR-033 | Futuro |
| Cutover Source→LUMEN | Transplante + F1/F2 | Sem demonstração ponta-a-ponta multi-tenant paga | Não demonstrado |
| Lead magnet self-serve | F1/F2 maduros | Modo A ainda não capacidade comercial | Não demonstrado |
| Lead magnet assisted | Ops founder | Cap 4/mês definido em 07; throughput medido = TBD | Parcial (processo) |
| Autonomia Tier 3 | Pós-F6 | Visão | Futuro |
| Unit economics sustentável | 08 | Todas as células críticas TBD | Não demonstrado |
| Relação com administradoras | ADR-045 | Hipótese; sem evidência de canal/cliente | Não demonstrado |

---

## Achados operacionais reportados (piloto / trials)

Registos abaixo cruzam limites no código/docs com trials reportados. Actualizar com data, commit e ambiente quando houver nova evidência.

### F1 — limite de upload e revisão humana

| Achado | Fonte | Implicação comercial |
|--------|-------|----------------------|
| Upload máximo **10MB** (`F1_MAX_UPLOAD_BYTES`); Content-Length early reject | F1-IMPLEMENTACAO; `f1-upload-guard.ts` | PDFs grandes de regulamento/arquivo **bloqueiam** onboarding self-serve |
| Trial reportado: PDF ~**11,6 MB** → bloqueado pelo limite 10MB | Evidência de piloto reportada (análise operacional externa ao pacote v6.1) | Onboarding **não** é capacidade comercial demonstrada |
| Linhas `needs_human_review` bloqueiam confirmação do lote | ADR-043; F1-IMPLEMENTACAO | Assistência humana obrigatória em ambiguidade |
| Trial reportado: após contornar o bloqueio de tamanho, pipeline produziu ~**977 candidatos**, **0 ready**, desfecho `needs_human_review` | Evidência de piloto reportada | Volume de extracção ≠ constituição confirmada; não vender "upload e está pronto" |
| Slice MinIO = validação técnica local; **não** staging/prod ready | F1-IMPLEMENTACAO | Não afirmar readiness de ingestão em produção |

### F2 — kernel ≠ operação ≠ negócio

| Achado | Fonte | Implicação comercial |
|--------|-------|----------------------|
| Cobertura de testes **não equivale** a F2 operacional ponta-a-ponta, cutover Fonte, gates ou negócio validado | F2-IMPLEMENTACAO; 06-FATIAS | Não vender "contabilidade de condomínio pronta" |
| Dual-write / cutover `Quota.pago` explicitamente fora | F2-IMPLEMENTACAO | Duas camadas no binário até cutover |

### F3 — portal depende da constituição

| Achado | Fonte | Implicação comercial |
|--------|-------|----------------------|
| Portal Essencial e convites existem como fatia | F3-IMPLEMENTACAO | Capacidade de produto parcial |
| Fluxo real incompleto sem fracções confirmadas, contactos e memberships operacionais | Conclusão de trial / arquitectura 11 | F3 não é só frontend |
| Push iOS FRAGILE (sem VAPID/APNs) | F3-IMPLEMENTACAO | Email como canal primário no piloto |

### Negócio / gates

| Achado | Fonte | Implicação comercial |
|--------|-------|----------------------|
| Dinheiro / votos / efeitos legais em produção = NO-GO até gates | 00-INDICE; PRODUCTION-GATES; README | Piloto controlado ≠ comercial geral |
| Fonte = prova técnica de reconciliação, não N tenants LUMEN | 07 | Não misturar claims |
| SOM / CAC / contribuição = TBD | 08 | Sem pitch de ARR inventado |

---

## Pergunta empresarial em aberto

> Conseguimos levar um condomínio real, com dados reais, autoridade real e problemas reais, desde o estado actual até uma operação LUMEN **paga, repetível e economicamente sustentável**?

**Resposta actual:** ainda **não demonstrada**. Arquitectura e código sério existem; capacidade comercial de transição/onboarding permanece objecto de validação.

---

## Protocolo de actualização

Após cada trial operacional:

1. Data, ambiente, commit/SHA, tenant (anonimizado se necessário).
2. Capacidade testada (linha da matriz).
3. Resultado (pass / blocked / parcial) + artefacto (log, screenshot, métricas).
4. Horas humanas gastas (alimentar 08).
5. Alterar estatuto só com evidência — nunca por progresso de PR isolado.

---

## Referências

- [00-INDICE](00-INDICE.md) — docs ≠ ops ≠ negócio  
- [F1-IMPLEMENTACAO](F1-IMPLEMENTACAO.md) / [F2-IMPLEMENTACAO](F2-IMPLEMENTACAO.md) / [F3-IMPLEMENTACAO](F3-IMPLEMENTACAO.md)  
- [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md) / [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md) / [11-ARQUITECTURA-NEGOCIO](11-ARQUITECTURA-NEGOCIO.md)  
- [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md)  
- [PRODUCTION-GATES](PRODUCTION-GATES.md)  
- ADR-045 (hipótese administradoras)
