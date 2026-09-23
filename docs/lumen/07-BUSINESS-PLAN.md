# 07 — Business Plan

> **Versão: v7.0 | Data: 2026-09-23 | Estado: ACEITE (reconciliação empresarial)**

> **Nota v7.0:** reconcilia o plano de empresa com o modelo de negócio ([10](10-MODELO-NEGOCIO.md)), a arquitectura do negócio ([11](11-ARQUITECTURA-NEGOCIO.md)) e a evidência operacional ([PROOF-SHEET](PROOF-SHEET.md)). Suaviza a relação com administradoras para **hipótese** (ADR-045). Eleva freeze de capacidade a regra de gestão. Formaliza Transição Source→LUMEN, horizontes 90d/12m/24m e separação visão | vendável | piloto | futuro. Mantém disciplina SAM/SOM/TBD e lead magnet A/B.

> **Nota v6.1 (preservada):** funil deliberativo medido, SAM como hipótese, SOM só pós-piloto, RC como risco #8, pricing alinhado às fatias, IoT fora do plano comercial (Tier 3), moat por valor histórico com portabilidade, linguagem Fonte vs LUMEN, checklist do founder.

Modelo de valor: [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md). Números: [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md).

---

## Camadas de progresso (não confundir)

| Camada | Pergunta | Onde vive |
|--------|----------|-----------|
| Estratégia | Devemos fazer isto? | 10, este documento |
| Negócio | Alguém paga por isto? | Este documento + 08 + PROOF-SHEET |
| Produto | Conseguimos fazê-lo? | 06, F*-IMPLEMENTACAO |
| Operação | Funciona no mundo real? | PROOF-SHEET, piloto |
| Economia | Conseguimos com margem? | 08 |

Progresso técnico **não** é proxy de progresso empresarial ([00-INDICE](00-INDICE.md)).

---

## Visão | Produto vendável | Piloto | Futuro

| Camada | O quê | Promessa comercial |
|--------|-------|--------------------|
| **Visão** | Sistema operacional de autogestão; Tier 3 / autonomia | Não se vende no piloto |
| **Produto vendável (agora)** | Plano **Essencial** — financeiro + portal + recibos/avisos | Único plano no piloto |
| **Piloto** | F0–F3 Essencial; assistência limitada; validação 5→20→40 | Capacidade e unit economics |
| **Futuro** | F4 ops, F5 governance, F6 Orquestra, Enterprise | Só após gates e retenção |

---

## Posicionamento

**LUMEN** (nome anterior: BuildingMind) não se vende como "mais uma app de gestão de condomínio com IA" — isso copia-se assim que um concorrente acrescenta um chatbot.

Formulação canónica (modelo de negócio):

> **O LUMEN é uma plataforma operacional que transforma a informação, decisões e obrigações de um condomínio numa memória verificável e utilizável para a sua autogestão.**

Posicionamento interno / visão de arquitectura (preservado):

> **LUMEN é o sistema operacional de autogestão do condomínio.**

A IA é substituível (hoje Groq/Llama, amanhã outro modelo — ver [03-ORQUESTRA](03-ORQUESTRA.md)). O que não é substituível, e cresce com o tempo de uso, é a **memória operacional** do edifício.

**Vantagem de confiança (não só técnica):** núcleo financeiro e de governação nunca depende da disponibilidade de um LLM (ADR-033); RAG nunca é fonte de verdade para factos financeiros (ADR-007); dinheiro e votos nunca são decididos pelo LLM.

Moat = valor histórico, não prisão de dados. Tenant Exit / portabilidade (ADR-037). Pitch:

> O LUMEN torna o histórico do condomínio mais valioso sem tornar o condomínio prisioneiro do LUMEN.

"Sistema operacional autónomo" é visão de longo prazo, não a promessa do primeiro lançamento.

**Fonte vs LUMEN** (obrigatório em qualquer pitch):

| | Fonte (prova) | LUMEN (produto) |
|---|---------------|-----------------|
| O quê | Motor de reconciliação **já validado em produção num condomínio** (Urbanização da Fonte) | Plataforma **multi-tenant em construção** |
| Âmbito | Single-tenant, prova operacional real | Produto SaaS multi-condomínio (F0–F6) |
| Como falar | "motor de reconciliação já validado em produção num condomínio" | "a plataforma multi-tenant está em construção" |

Nunca misturar as duas afirmações como se a plataforma multi-tenant já estivesse em produção.

---

## Proposta de valor

| Para quem | Problema | Solução |
|-----------|----------|---------|
| Administradores não-profissionais (condóminos-admin) | Complexidade legal, falta de tempo, ferramentas inadequadas | Setup guiado, apoio jurídico consultivo, onboarding por convite |
| Condóminos | Falta de transparência, dificuldade em reportar problemas | Portal via convite, tickets com foto, votação digital (quando F5 + gates) |
| Condomínios que já pagam a uma administradora profissional | Custo elevado, opacidade, dependência de terceiros | Alternativa de autogestão assistida — **hipótese de conversão a validar** |

### Relação com administradoras (ADR-045)

O **posicionamento inicial** é autogestão assistida. A relação com administradoras profissionais — concorrência, cliente, parceiro ou canal — é **hipótese comercial a validar** no piloto. Não é decisão irrevogável.

Até haver evidência medida: não modelar CAC via administradoras nem imobiliárias com o mesmo conflito (ADR-019). Experiência APEGAC/ANACON = baixo compromisso, nunca premissa financeira.

---

## Funil deliberativo (aquisição real)

O ciclo de venda não é "demo → assinatura". É um funil deliberativo institucional:

```
interessado
  → relatório de reconciliação (lead magnet)
  → 1–2 champions no prédio
  → ordem do dia (assembleia)
  → deliberação / voto
  → onboarding do tenant / transição
```

| Métrica | O que mede |
|---------|------------|
| **Time to assembly** | Dias entre primeiro contacto / relatório e a assembleia que delibera |
| **Vote-yes rate** | % de deliberações favoráveis (entre as que chegaram a voto) |
| **Drop-off before vote** | % que avançam até champions / ordem do dia mas nunca votam |

Estas métricas alimentam o [08](08-PLANO-FINANCEIRO.md) — sem elas, CAC e win-rate são ficção.

---

## Transição Source → LUMEN (oferta inicial)

O cliente compra a **passagem** para uma operação controlada, não um tenant vazio.

```text
Documentos + dados + extratos + fracções + autoridade
        ↓
   Reconstrução (constituição / Data-to-State)
        ↓
   Reconciliação
        ↓
   Confirmação humana
        ↓
   Shadow run (quando aplicável)
        ↓
   Cutover → operação LUMEN
```

Isto é capacidade empresarial (**Condominium Transition**), não só pipeline técnico. Estatuto actual: **objecto de validação operacional** — onboarding ainda não é capacidade comercial demonstrada ([PROOF-SHEET](PROOF-SHEET.md)).

Durante o piloto a transição usa assistência com cap; o objectivo é productizar e reduzir assistência (10, 11).

---

## Modelo de receita

### SaaS — preço por condomínio/mês

| Plano | Frações | Preço/mês | Inclui | Quando se vende |
|-------|---------|-----------|--------|-----------------|
| **Essencial** | até 20 | 29€ | Financeiro + portal + recibos | Único plano no piloto — **hipótese de preço**, não "preço certo" |
| **Profissional** | até 50 | 59€ | + orçamentos + atas + votação | Só depois de F5 + Production Gates |
| **Enterprise** | ilimitado | 99€ | + Orquestra LLM + API | Y1+, só depois de F6 |

> IoT fora do plano comercial (Tier 3). Não usar "50k × 44€" como mercado endereçável.

### Add-ons

| Add-on | Preço | Nota |
|--------|-------|------|
| Enable Banking (sync automático) | +9€/mês | Custo real da API a validar — ver 08 |
| Transcrição áudio (Whisper) | €0.006/min | Pass-through + 20% |
| LLM avançado (orçamentos, atas) | €0.01/request | Pass-through + 30%; tokens **secundários** |
| Seguro RC do admin autogerido | TBD | Add-on a validar com seguradora |

Unit economics completo: [08](08-PLANO-FINANCEIRO.md).

---

## Mercado

### Portugal

- ~500.000 condomínios — universo teórico (TAM macro)
- ~3.000 administradores profissionais — relação **hipótese** (ADR-045); não canal modelado
- ~50.000 condóminos-admin (autogestão) — **hipótese de mercado, não facto**

### TAM / SAM / SOM

| | Estatuto |
|---|----------|
| TAM ~500.000 | Macro, não acionável directamente |
| SAM ~50.000 | Hipótese — a validar; não base de ARR |
| SOM Y1 / Y3 | TBD pós-piloto |
| ARR tipo "50k × 44€" | Proibido |

Critério de validação: **5 → 20 → 40** condomínios com CAC e win-rate medidos. Só depois o SOM deixa de ser TBD.

A pergunta empresarial central:

> Conseguimos levar um condomínio real, com dados reais e autoridade real, até uma operação LUMEN **paga, repetível e economicamente sustentável**?

A resposta ainda **não** está demonstrada ([PROOF-SHEET](PROOF-SHEET.md)).

---

## Go-to-Market

Foco: canais directos e funil deliberativo. Sem CAC institucional modelado.

### Regras de gestão (obrigatórias)

Elevam as regras de [06-FATIAS](06-FATIAS.md) a governação da empresa:

1. **Não** distribuir além do piloto enquanto F0–F2 não estiverem estáveis.
2. **Freeze** de features "nice" de F4–F6 até 10 tenants pagos ou fim do piloto.
3. **Não** contratar para escalar vendas antes de provar onboarding / transição.
4. **Não** desenvolver Enterprise / F4–F6 só porque um potencial cliente pede.
5. **Não** aumentar aquisição enquanto o custo de entrega (humano + infra) não estiver conhecido.
6. Lead magnet assisted: **máximo 4/mês**.

### Fase 1: Piloto

- Critério 5→20→40 (Fonte = prova técnica, não "N tenants LUMEN")
- Vender apenas Essencial (29€ = hipótese)
- Validar funil + métricas + custo de transição
- Lead magnet nos dois modos abaixo

### Lead magnet — Relatório de Reconciliação Financeira

A Fonte valida o motor de reconciliação num condomínio; isso **não** demonstra entrega multi-tenant nem valor comercial. O relatório só conclui imputações/obrigações com dados de referência autorizados e rastreáveis. Com só um extrato: análise de movimentos + questões a confirmar.

Diagnóstico assistido **não** substitui cutover nem torna o LUMEN fonte financeira autoritativa. Nunca afirmar "está a pagar a mais" / fraude definitiva sem evidência suficiente.

| Modo | Quando | Como |
|------|--------|------|
| **A — Self-serve** | Quando F1/F2 estiverem suficientemente maduros | Interessado sobe extrato; relatório sem intervenção contínua |
| **B — Assisted** | Piloto (enquanto A não estiver pronto) | Founder/equipa — **máx. 4/mês** |

### Fase 2: Early adopters (após piloto + F0–F2 estáveis)

- Preço de lançamento (−30%) no Essencial; Profissional só se F5 + gates
- Facebook / WhatsApp locais; condómino-embaixador; notários/construtoras
- Associações: só experiência, sem CAC modelado

### Fase 3: Crescimento (Y2+)

- Preço normal; self-service onboarding; SEO/guias
- Marketplace de fornecedores (avaliar)
- Expansão ES/BR só após validação em Portugal (não antes do Y3)

---

## Horizontes e gates de investimento

| Horizonte | Foco | Gate para avançar |
|-----------|------|-------------------|
| **90 dias** | Estabilizar F0–F3 Essencial; instrumentar funil e custo humano; ≤4 assisted/mês; primeiros tenants piloto com champion | Evidência de transição parcial documentada no PROOF-SHEET; sem distribuição ampla |
| **12 meses** | Patamares 5→20; self-serve do lead magnet; unit economics com dados; decisão sobre hipótese administradoras | CAC/win-rate medidos; contribuição por tenant conhecida; freeze F4–F6 respeitado |
| **24 meses** | Patamar 40; F5 + Production Gates se retenção o justificar; Profissional só então | Renovação paga; gates PASS/WAIVED; SOM deixa de ser TBD só com evidência |

Investir em aquisição ou F4–F6 **antes** destes gates é violação das regras de gestão.

---

## Vantagem competitiva

| Factor | LUMEN | Software tradicional / Administradora |
|--------|-------|---------------------------------------|
| Setup | Upload → confirmação linha a linha (capacidade ainda parcial) | Inserção manual / onboarding de administradora |
| Ativação | Contactos → admin confirma → convites em lote | Condóminos "descobrem" a app |
| Acesso | Convite individual → portal | App / PDF por email |
| Documentos financeiros | Aviso de Débito e Recibo a partir do Ledger | Manuais, muitas vezes atrasados |
| Reconciliação | Motor validado na Fonte; multi-tenant em construção | Manual |
| Confiança IA | LLM subordinado; finanças/governação determinísticas | Chatbot como "cérebro" ou processo opaco |
| Saída | Tenant Exit / portabilidade | Lock-in de ficheiros dispersos |

---

## Responsabilidade civil e limites de autonomia

Antes do lançamento comercial geral:

1. **Human override** — ações de risco elevado paráveis/revertíveis por humano autorizado
2. **Approval gates** — compromissos financeiros/jurídicos exigem `Approval` versionada
3. **Autonomy limits** — LLM nunca decide dinheiro nem votos
4. **Disclaimer / termos** — o LUMEN assiste; responsabilidade no órgão competente do condomínio

Seguro RC admin = add-on a validar. Ver risco #8 e [PRODUCTION-GATES](PRODUCTION-GATES.md).

---

## Equipa necessária (Fase 1)

| Papel | FTE |
|-------|-----|
| Founder / Product + Dev | 1 (existente) |
| Frontend / Design | 0.5 (freelance) |
| Legal advisor | 0.1 (consultoria pontual) |
| DPO / privacidade | pontual, antes de dados pessoais reais em produção |

> Risco #6: esta equipa acumula multi-tenant, GTM e suporte — daí as regras de gestão.

Organização futura: [11-ARQUITECTURA-NEGOCIO](11-ARQUITECTURA-NEGOCIO.md).

---

## Riscos

| # | Risco | Mitigação |
|---|-------|-----------|
| 1 | Aquisição (CAC, ciclo deliberativo, drop-off) | Piloto com métricas; canais directos; não modelar CAC institucional |
| 2 | Adopção lenta | Relatório factual; champions; piloto Essencial |
| 3 | Concorrência (administradoras; software tipo Condomínio Digital, Habitak) | Preço, transparência, prova Fonte + portabilidade; hipótese ADR-045 |
| 4 | RGPD | Dados em EU; isolamento por tenant; Orquestra só com anonimização robusta se houver aprendizagem agregada |
| 5 | Dependência de APIs (Enable Banking, Groq) | Fallbacks (CSV, OpenRouter) |
| 6 | Execução num único founder | Regras de gestão; freeze F4–F6; reforço antes de escalar |
| 7 | Custo de tokens LLM | Secundário — ver 08 |
| 8 | RC / prejuízo por decisão assistida | Override, gates, disclaimer; RC add-on; Liability em PRODUCTION-GATES |
| 9 | Onboarding/transição não repetível | PROOF-SHEET; medir custo humano; não escalar aquisição cedo |

---

## Checklist do founder (acções de negócio — não código)

- [ ] Critério de entrada no piloto: champion nomeado e assembleia agendada ou agendável em ≤60 dias
- [ ] Linguagem Fonte vs LUMEN em todos os materiais
- [ ] Funil deliberativo com métricas desde o primeiro lead
- [ ] Cap assisted: máximo 4/mês
- [ ] Não distribuir além do piloto até F0–F2 estáveis
- [ ] Congelar priorização comercial de F4–F6 até 10 pagos ou fim do piloto
- [ ] Vender só Essencial; 29€ tratado como hipótese; não prometer Profissional/Enterprise/IoT
- [ ] Medir CAC e win-rate em 5 → 20 → 40; SOM TBD até lá
- [ ] Instrumentar horas de transição / suporte por tenant (unit economics)
- [ ] Actualizar PROOF-SHEET após cada trial operacional real
- [ ] Inquérito qualitativo (10–20 condóminos-admin) antes de apresentar SAM a investidores
- [ ] Não usar CAC institucional nem ARR "50k × 44€"
- [ ] Validar Production Gates com advogado/DPO antes de dinheiro/votos/efeitos legais reais
- [ ] Explorar seguro RC admin (sem fechar preço antes de proposta)
- [ ] Política comercial de Tenant Exit (formato, prazo)
- [ ] Office hours semanais, não 24/7
- [ ] Contratar 0.5 frontend só depois do vertical slice F1 verde
- [ ] Revisitar hipótese administradoras (ADR-045) só com evidência

---

## Referências

- Modelo de negócio: [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md)
- Arquitectura do negócio: [11-ARQUITECTURA-NEGOCIO](11-ARQUITECTURA-NEGOCIO.md)
- Evidência: [PROOF-SHEET](PROOF-SHEET.md)
- Narrativa financeira: [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md)
- Orquestra / LLM: [03-ORQUESTRA](03-ORQUESTRA.md)
- Fatias: [06-FATIAS](06-FATIAS.md)
- Gates: [PRODUCTION-GATES](PRODUCTION-GATES.md)
- ADR-045: posicionamento vs administradoras
