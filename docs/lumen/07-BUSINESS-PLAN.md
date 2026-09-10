# 07 — Business Plan

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> **Nota v6.1:** endurece consistência comercial e de capacidade — funil deliberativo medido, SAM como hipótese, SOM só pós-piloto, responsabilidade civil como risco #8, regra de capacidade (sem distribuição além do piloto até F0–F2 estáveis), pricing alinhado às fatias, IoT fora do plano comercial (Tier 3), moat por valor histórico com portabilidade, linguagem Fonte vs LUMEN, lead magnet em dois modos, checklist do founder.

## Posicionamento

**LUMEN** (nome anterior: BuildingMind) não se vende como "mais uma app de gestão de condomínio com IA" — isso copia-se assim que um concorrente acrescenta um chatbot. O posicionamento interno e a visão de arquitectura:

> **LUMEN é o sistema operacional de autogestão do condomínio.**

A IA é substituível (hoje Groq/Llama, amanhã outro modelo, sem reconstruir o produto — ver [03-ORQUESTRA](03-ORQUESTRA.md)). O que não é substituível, e cresce com o tempo de uso, é a memória operacional do edifício: o que foi decidido, quanto se deve, o que foi pago, que fornecedores foram usados, que problemas ocorreram.

Moat = valor histórico, não prisão de dados. Quanto mais tempo um condomínio usa o LUMEN, mais valioso fica o histórico — mas sair não pode significar "perder tudo". O produto prevê Tenant Exit / portabilidade (exportação estruturada: constituição, ledger, atas, documentos, memberships) para que o moat seja confiança e continuidade, não lock-in artificial. Ver [03-ORQUESTRA](03-ORQUESTRA.md) e [PRODUCTION-GATES](PRODUCTION-GATES.md) (privacidade / exportação).

"Sistema operacional autónomo" é visão arquitectural de longo prazo, não a promessa comercial do primeiro lançamento. Até o Tier 3 estar construído, o que vai a mercado é uma app de gestão de condomínio com IA bem desenhada — e é honesto dizê-lo.

**Fonte vs LUMEN** (obrigatório em qualquer pitch ou conversa comercial):

| | Fonte (prova) | LUMEN (produto) |
|---|---------------|-----------------|
| O quê | Motor de reconciliação **já validado em produção num condomínio** (Urbanização da Fonte) | Plataforma **multi-tenant em construção** |
| Âmbito | Single-tenant, prova operacional real | Produto SaaS multi-condomínio (F0–F6) |
| Como falar | "motor de reconciliação já validado em produção num condomínio" | "a plataforma multi-tenant está em construção" |

Nunca misturar as duas afirmações como se a plataforma multi-tenant já estivesse em produção.

## Proposta de valor

| Para quem | Problema | Solução |
|-----------|----------|---------|
| Administradores não-profissionais (condóminos-admin) | Complexidade legal, falta de tempo, ferramentas inadequadas | Setup guiado, apoio jurídico consultivo, onboarding por convite individual |
| Condóminos | Falta de transparência, dificuldade em reportar problemas | Portal via convite, tickets com foto, votação digital (quando F5 + gates) |
| Condomínios que já pagam a uma administradora profissional | Custo elevado, opacidade, dependência de terceiros | Alternativa de autogestão assistida por IA, mais barata e transparente |

O produto compete com empresas de gestão de condomínio — não é complementar a elas. Parcerias com administradoras profissionais ou imobiliárias (que tipicamente têm acordos com administradoras) não são canais viáveis.

## Funil deliberativo (aquisição real)

O ciclo de venda não é "demo → assinatura". É um funil deliberativo institucional do condomínio:

```
interessado
  → relatório de reconciliação (lead magnet)
  → 1–2 champions no prédio
  → ordem do dia (assembleia)
  → deliberação / voto
  → onboarding do tenant
```

Métricas a instrumentar desde o piloto (não inventar números antes de os medir):

| Métrica | O que mede |
|---------|------------|
| **Time to assembly** | Dias entre primeiro contacto / relatório e a assembleia que delibera |
| **Vote-yes rate** | % de deliberações favoráveis à adopção do LUMEN (entre as que chegaram a voto) |
| **Drop-off before vote** | % de leads que avançam até champions / ordem do dia mas nunca chegam a votação |

Estas métricas alimentam o [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md) — sem elas, CAC e win-rate são ficção.

## Modelo de receita

### SaaS — preço por condomínio/mês

| Plano | Frações | Preço/mês | Inclui | Quando se vende |
|-------|---------|-----------|--------|-----------------|
| **Essencial** | até 20 | 29€ | Financeiro + portal do condómino (onboarding por convite) + recibos | Único plano vendido no piloto |
| **Profissional** | até 50 | 59€ | + orçamentos + atas + votação | Só depois de F5 + Production Gates |
| **Enterprise** | ilimitado | 99€ | + Orquestra LLM + API | Y1+, só depois de F6 |

> IoT removido do plano comercial. Estacionamento inteligente / IoT fica em Tier 3 — Futuro; não entra em nenhum tier de preço nem em pitch comercial. Ver [03-ORQUESTRA](03-ORQUESTRA.md).

> Sequenciamento: no piloto vende-se apenas Essencial. Profissional exige F5 estável e gates de produção (actas, votos, efeitos legais). Enterprise exige F6. Não usar um "preço médio" tipo 50k × 44€ como se fosse mercado endereçável — ver SAM/SOM abaixo e [08](08-PLANO-FINANCEIRO.md).

### Add-ons

| Add-on | Preço | Nota |
|--------|-------|------|
| Enable Banking (sync automático) | +9€/mês | Custo real da API a validar com fornecedor — ver 08 |
| Transcrição áudio (Whisper) | €0.006/min | Pass-through + 20% |
| LLM avançado (orçamentos, atas) | €0.01/request | Pass-through + 30%; custo de tokens é **secundário** |
| Seguro RC do admin autogerido | TBD | Add-on a validar com seguradora — não é premissa fechada |

## Mercado

### Portugal

- ~500.000 condomínios — universo teórico, não o mercado que o produto serve hoje
- ~3.000 administradores profissionais (não são canal — são concorrência)
- ~50.000 condóminos-admin (autogestão) — **hipótese de mercado, não facto validado**

### TAM / SAM / SOM

- **TAM:** todos os condomínios em Portugal potencialmente digitalizáveis — ~500.000. Número macro, não alvo de vendas.
- **SAM:** condomínios onde a autogestão digital é alternativa plausível. A estimativa de ~50.000 é hipótese não validada — precisa de fonte e metodologia antes de ir a um investidor como facto.
- **SOM Y1 / Y3:** cenários só após o piloto — não são metas de pitch. Células numéricas ficam TBD no [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md) até haver CAC e win-rate medidos.

| | Estatuto |
|---|----------|
| TAM ~500.000 | Macro, não acionável directamente |
| SAM ~50.000 | Hipótese — a validar; não usar como base de ARR |
| SOM Y1 / Y3 | TBD pós-piloto — não inventar 40–200 / 400–2.000 como targets de pitch |
| ARR tipo "50k × 44€" | Não usar como se fosse mercado endereçável |

Critério de validação (não projecção): 5 → 20 → 40 condomínios, com CAC e win-rate medidos em cada patamar. Só depois disto o SOM deixa de ser TBD.

A pergunta útil: quantos condomínios convertemos de administradora profissional para autogestão assistida, pelos canais que controlamos? Essa resposta só existe depois do piloto.

## Go-to-Market

Sem administradoras como canal. Também sem imobiliárias com o mesmo conflito. Associações profissionais (APEGAC/ANACON) = experiência de baixo compromisso, nunca premissa de CAC no plano financeiro.

Foco: canais directos que a empresa controla — funil deliberativo acima.

### Regra de capacidade (obrigatória)

1. Sem distribuição além do piloto até F0–F2 estarem estáveis (multi-tenant, ingestão, ledger/reconciliação fiáveis).
2. Congelar features "nice" de F4–F6 até 10 tenants pagos ou fim do piloto — o que ocorrer primeiro. F4–F6 continuam como contrato arquitectural; não são prioridade de capacidade comercial.

### Fase 1: Piloto

- Até ao critério 5→20→40 (começar pequeno; Fonte conta como prova técnica, não como "N tenants LUMEN")
- Vender apenas Essencial
- Validar funil completo e métricas (time to assembly, vote-yes, drop-off)
- Instrumentar CAC real e volume de suporte desde o dia 1 (ver 08)
- Lead magnet nos dois modos abaixo

### Lead magnet — Relatório de Reconciliação Financeira

Usando o motor de reconciliação já validado em produção num condomínio, oferece-se a qualquer condomínio interessado um relatório objetivo a partir do extrato bancário: movimentos reconciliados, não identificados, pagamentos potencialmente mal imputados, obrigações sem correspondência, itens a confirmar por humano. Nunca afirma "está a pagar a mais" nem aponta fraude de forma definitiva.

| Modo | Quando | Como |
|------|--------|------|
| **A — Self-serve** | Quando F1/F2 existirem na plataforma multi-tenant | O interessado sobe o extrato e recebe o relatório sem intervenção manual contínua |
| **B — Assisted** | Durante o piloto (e enquanto A não estiver pronto) | Relatório assistido pelo founder / equipa — máximo 4 por mês (cap duro de capacidade) |

### Fase 2: Early adopters (após piloto + F0–F2 estáveis)

- Preço de lançamento (−30%) no Essencial; Profissional só se F5 + gates
- Grupos de Facebook / WhatsApp de bairro e freguesia
- Programa condómino-embaixador (ex.: 3 meses grátis a quem trouxer o prédio ao lado)
- Parcerias no momento de constituição: notários e construtoras
- Associações: só como experiência, sem CAC modelado

### Fase 3: Crescimento (Y2+)

- Preço normal
- Self-service onboarding
- SEO / guias práticos de assembleia sem administrador
- Marketplace de fornecedores por zona (avaliar)
- Expansão ES/BR só depois de validação em Portugal (não antes do Y3)

## Vantagem competitiva

| Factor | LUMEN | Software tradicional / Administradora |
|--------|-------|---------------------------------------|
| Setup | Upload PDF → confirmação linha a linha | Inserção manual / onboarding de administradora |
| Ativação | Importa contactos → admin confirma → convites em lote | Condóminos "descobrem" a app sozinhos |
| Acesso | Convite individual → portal | App a instalar / PDF por email |
| Documentos financeiros | Aviso de Débito e Recibo a partir do Ledger | Manuais, muitas vezes atrasados |
| Reconciliação | Motor já validado em produção num condomínio; plataforma multi-tenant em construção | Manual |
| Ligação bancária | Ciclo de vida gerido (`BankConnection`) | Reautorização manual esquecida |
| Comunicação | Boca única + revisão em camadas | Cada módulo envia para o seu lado |
| Atas / votos | Áudio → minuta → aprovação pelos condóminos / `ResolutionRule` | Escrita manual |
| Custo | Fração do custo de uma administradora | Honorários profissionais |
| Saída | Tenant Exit / portabilidade | Lock-in típico de ficheiros dispersos |

## Responsabilidade civil e limites de autonomia (produto)

Uma administradora profissional tem seguro de RC; um condómino-admin tipicamente não. Antes do lançamento comercial geral, o produto tem de deixar explícito:

1. **Human override** — qualquer ação de risco elevado pode ser parada ou revertida por humano com autoridade adequada
2. **Approval gates** — compromissos financeiros/jurídicos exigem `Approval` versionada (ver 02 / 03)
3. **Autonomy limits** — o LLM nunca decide dinheiro nem votos; finanças e governação não dependem da disponibilidade do LLM
4. **Disclaimer / termos** — o LUMEN assiste; a responsabilidade das decisões continua no órgão competente do condomínio

Seguro RC do admin autogerido = add-on comercial a validar com seguradora (não assumir fechado). Ver risco #8 e [PRODUCTION-GATES](PRODUCTION-GATES.md) (Liability).

## Equipa necessária (Fase 1)

| Papel | FTE |
|-------|-----|
| Founder / Product + Dev | 1 (existente) |
| Frontend / Design | 0.5 (freelance) |
| Legal advisor | 0.1 (consultoria pontual) |
| DPO / privacidade | pontual, antes de produção com dados pessoais reais |

> Ver risco #6: esta equipa acumula refactor multi-tenant, GTM e suporte — ponto de atenção, não detalhe de organograma.

## Riscos

| # | Risco | Mitigação |
|---|-------|-----------|
| 1 | Aquisição de clientes (CAC, ciclo deliberativo, drop-off antes do voto) | Piloto com métricas do funil; canais directos; não modelar CAC institucional — ver [08](08-PLANO-FINANCEIRO.md) |
| 2 | Adopção lenta (inércia do sector) | Relatório de reconciliação (linguagem factual); champions 1–2; piloto Essencial |
| 3 | Concorrência (administradoras; software tipo Condomínio Digital, Habitak) | Preço, transparência, prova Fonte + portabilidade |
| 4 | Regulamentação RGPD | Dados em EU, consentimento, isolamento por tenant; Orquestra só com anonimização robusta se houver aprendizagem agregada |
| 5 | Dependência de APIs (Enable Banking, Groq) | Fallbacks (CSV manual, OpenRouter) |
| 6 | Execução concentrada num único founder | Regra de capacidade; congelar F4–F6 nice features; reforço de equipa antes de escalar |
| 7 | Custo de tokens LLM | Secundário aos preços actuais — ver 08; não é o risco nº1 |
| 8 | Responsabilidade civil / prejuízo por decisão assistida | Human override, approval gates, limites de autonomia, disclaimer/termos; seguro RC admin como add-on a validar; gates de Liability em [PRODUCTION-GATES](PRODUCTION-GATES.md) |

## Checklist do founder (acções de negócio — não código)

- [ ] Critério de entrada no piloto: só aceitar prédios com champion nomeado e assembleia já agendada ou agendável em ≤60 dias
- [ ] Fechar linguagem Fonte vs LUMEN em todas as conversas e materiais (frase: "motor de reconciliação já validado em produção num condomínio; a plataforma multi-tenant está em construção")
- [ ] Correr o funil deliberativo com métricas (time to assembly, vote-yes, drop-off) desde o primeiro lead
- [ ] Cap do lead magnet assisted: máximo 4/mês no piloto; resto espera self-serve
- [ ] Não distribuir além do piloto até F0–F2 estáveis
- [ ] Congelar priorização comercial de F4–F6 até 10 pagos ou fim do piloto
- [ ] Vender só Essencial no piloto; não prometer Profissional/Enterprise/IoT
- [ ] Medir CAC e win-rate nos patamares 5 → 20 → 40; deixar SOM como TBD até lá
- [ ] Inquérito qualitativo (10–20 condóminos-admin) antes de apresentar SAM a investidores
- [ ] Não usar CAC institucional nem ARR "50k × 44€" em pitch
- [ ] Validar com advogado/DPO os Production Gates antes de dinheiro/votos/efeitos legais reais
- [ ] Explorar seguro RC admin como add-on (sem fechar preço antes de proposta de seguradora)
- [ ] Definir política comercial de Tenant Exit / portabilidade (o que exportamos, em que formato, em que prazo)
- [ ] Instrumentar suporte e tempo gasto por tenant no piloto (capacidade real vs desejo de crescimento); office hours semanais, não 24/7
- [ ] Contratar 0.5 frontend só depois do vertical slice F1 verde

## Referências

- Narrativa financeira e fórmulas: [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md)
- Orquestra e limites do LLM: [03-ORQUESTRA](03-ORQUESTRA.md)
- Fatias e capacidade técnica: [06-FATIAS](06-FATIAS.md)
- Gates antes de produção real: [PRODUCTION-GATES](PRODUCTION-GATES.md)
