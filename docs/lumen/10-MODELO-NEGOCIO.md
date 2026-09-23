# 10 — Modelo de Negócio

> **Versão: v7.0 | Data: 2026-09-23 | Estado: ACEITE (reconciliação empresarial)**

> Responde: **como o LUMEN cria, entrega e captura valor?**  
> Plano de empresa e GTM: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md). Números: [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md). Como a empresa opera: [11-ARQUITECTURA-NEGOCIO](11-ARQUITECTURA-NEGOCIO.md). Evidência: [PROOF-SHEET](PROOF-SHEET.md).  
> ADR de posicionamento: [ADR-045](ADR-LOG.md#adr-045--relação-com-administradoras--hipótese-icp-inicial--autogestão-assistida).

---

## 1. Tese

O LUMEN **não é, em primeiro lugar, uma aplicação de condomínios com chatbot**. É infraestrutura operacional para o condomínio assumir e manter controlo sobre a sua própria operação.

Formulação canónica:

> **O LUMEN é uma plataforma operacional que transforma a informação, decisões e obrigações de um condomínio numa memória verificável e utilizável para a sua autogestão.**

A partir dessa memória:

> **O LUMEN ajuda as pessoas autorizadas a preparar, executar, verificar e automatizar operações.**

Cadeia produto ↔ negócio:

```text
constituição → memória → finanças → governance → operações → autoridade → evidência → automação
```

Visão arquitectural de longo prazo ("sistema operacional autónomo" / Tier 3) **não** é a promessa comercial do primeiro lançamento. O que se vende no piloto é o plano **Essencial** (ver 07).

---

## 2. Problema

| Sintoma | Custo para o condomínio |
|---------|-------------------------|
| Constituição e histórico dispersos (PDF, Excel, email, pasta do admin) | Erros de permilagem, contactos incompletos, onboarding lento |
| Obrigações e pagamentos sem reconciliação verificável | Opacidade, conflitos, impossibilidade de assembleia informada |
| Decisões sem cadeia de evidência / autoridade | Risco legal e de confiança |
| Dependência de terceiros opacos ou de ferramentas inadequadas para autogestão | Tempo, dinheiro, perda de controlo |

O cliente não compra "software vazio". Compra a **passagem** de uma realidade administrativa confusa para uma realidade operacional controlada (ver secção Transição em 07 e 11).

---

## 3. Cliente, comprador, utilizador

| Papel | Quem | Nota |
|-------|------|------|
| **ICP inicial** | Condomínio em autogestão (condómino-admin / órgãos competentes) | Posicionamento inicial = autogestão assistida (ADR-045) |
| **Comprador** | Órgão que delibera e autoriza despesa (assembleia / admin com mandato) | Funil deliberativo institucional (07) |
| **Utilizador admin** | Pessoa com `Membership` e autoridade no tenant | Opera constituição, finanças, tickets |
| **Utilizador condómino** | Titular/ocupante via convite | Portal: ledger view, tickets, contacto |
| **Administradora profissional** | Hipótese aberta | Concorrência, cliente, parceiro ou canal — **a validar**; não premissa de CAC (ADR-019, ADR-045) |

---

## 4. Proposta de valor

- **Memória operacional do edifício** — o que foi decidido, devido, pago, reportado — com evidência e proveniência.
- **Autogestão assistida** — reduz trabalho repetitivo sem transferir a responsabilidade legal para o LLM.
- **Transição assistida** (piloto) — reconstrução + reconciliação com limite de capacidade; depois self-serve.
- **Portabilidade** — moat = valor histórico, não prisão de dados (Tenant Exit).

Formulação de posicionamento (pitch curto):

> O LUMEN torna o histórico do condomínio mais valioso sem tornar o condomínio prisioneiro do LUMEN.

---

## 5. Jobs-to-be-done

| Job | Resultado desejado |
|-----|-------------------|
| Constituit o condomínio a partir de documentos e dados existentes | Frações, permilagens, pessoas, contactos confirmados |
| Reconciliar extratos com obrigações | Posição financeira compreensível e auditável |
| Activar condóminos | Convites → portal sem "descobrir a app" |
| Operar o dia-a-dia | Tickets, recibos/avisos a partir do Ledger, suporte mínimo |
| Preparar assembleia (futuro F5) | Kit, votos, acta com gates |
| Sair sem perder o histórico | Exportação estruturada |

---

## 6. Cadeia de valor

```text
              LUMEN
                │
       ┌────────┴────────┐
       │                 │
   SOFTWARE          ASSISTÊNCIA
   (recorrente)      (onboarding /
                     reconciliação)
       │                 │
       └────────┬────────┘
                │
          reduzir assistência
                ↓
        aumentar margem
```

Objectivo da assistência: **aprender e productizar** trabalho repetitivo — não manter serviço forever. Cap duro no piloto: máximo 4 relatórios assistidos/mês (07).

Valor empresarial:

```text
transição → operação recorrente → redução de trabalho → aumento de controlo → retenção
```

---

## 7. Moat

```text
mais utilização → mais memória → mais contexto → melhor operação → mais valor
```

Mas:

```text
valor acumulado ≠ lock-in
```

Moat = histórico verificável (Ledger, AuditEvent, Membership, Evidence) + execução com confiança. Portabilidade (ADR-037) é feature de posicionamento, não afterthought.

A IA é substituível; o núcleo financeiro/governação **não** depende de LLM (ADR-033). RAG **nunca** é fonte de verdade financeira (ADR-007). Isto é vantagem de **confiança**, não só decisão técnica.

---

## 8. Canais

Canais **directos** que a empresa controla (funil deliberativo em 07):

- Lead magnet — Relatório de Reconciliação (self-serve quando maduro; assisted no piloto)
- Grupos locais / embaixadores / notários e construtoras (constituição PH)
- Experiência institucional (APEGAC/ANACON) — **sem** CAC modelado

Canais via administradoras / imobiliárias com conflito: **hipótese**, não premissa (ADR-045).

---

## 9. Receita

| Tipo | Forma | Estatuto |
|------|-------|----------|
| SaaS recorrente | Essencial 29€ / Profissional 59€ / Enterprise 99€ | 29€ = **hipótese de preço do piloto**; outros tiers só após gates (07) |
| Add-ons | Enable Banking, Whisper, LLM, RC admin | Custos reais TBD (08) |
| Assistência | Incluída no piloto com cap; não linha de receita inventada | Capacidade, não P&L fictício |

Não projectar ARR a partir de "50.000 × 44€" (ADR-018, 08).

---

## 10. Custos (estrutura)

| Classe | Exemplos | Estatuto |
|--------|----------|----------|
| Fixos | Cloud, BD, ferramentas, legal/DPO | TBD medido (08) |
| Variáveis / tenant | Storage, tokens, banking, **suporte humano** | TBD; humano é crítico no piloto |
| Aquisição | Tempo e € por canal directo | CAC medido 5→20→40 |
| Entrega / transição | Horas onboarding, excepções, retrabalho | Objecto de validação (PROOF-SHEET) |

---

## 11. Unit economics (estrutura — sem inventar números)

```text
Receita líquida
− custo humano (onboarding + operação + suporte)
− infraestrutura
− IA / tokens
− serviços externos
− suporte residual
= contribuição por condomínio / ciclo
```

Detalhe de fórmulas, cenários e células TBD: [08-PLANO-FINANCEIRO](08-PLANO-FINANCEIRO.md).  
Medição obrigatória: horas onboarding, minutos operação, excepções, erros, retrabalho, utilização, renovação.

Um primeiro pagamento valida uma **transacção**, não retenção nem economia sustentável.

---

## 12. Riscos e hipóteses abertas

| Hipótese | Como invalidar / validar |
|----------|--------------------------|
| Autogestão assistida é ICP pagante | Funil deliberativo + renovação paga |
| €29 Essencial cobre entrega no piloto | Unit economics medido (08) |
| Onboarding/transição é repetível com margem | PROOF-SHEET + custo humano |
| Relação com administradoras | ADR-045 — evidência no piloto |
| Self-serve do lead magnet reduz assistência | Cap 4/mês + tempo a F1/F2 estáveis |
| Moat por memória + portabilidade retém | Renovação + pedidos de exit sem churn por lock-in |

Riscos de negócio detalhados: 07. Gates de produção: [PRODUCTION-GATES](PRODUCTION-GATES.md).

---

## 13. O que este documento não faz

- Não substitui [07](07-BUSINESS-PLAN.md) (empresa, GTM, horizontes).
- Não inventa SOM/CAC/ARR.
- Não afirma que F1–F3 são capacidades comerciais demonstradas — ver [PROOF-SHEET](PROOF-SHEET.md).
