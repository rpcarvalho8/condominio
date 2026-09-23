# 11 — Arquitectura do Negócio

> **Versão: v7.0 | Data: 2026-09-23 | Estado: ACEITE (reconciliação empresarial)**

> Responde: **como a empresa tem de funcionar para entregar o modelo?**  
> Valor: [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md). Empresa/GTM: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md). Domínio técnico: [02-DOMINIO](02-DOMINIO.md). Evidência: [PROOF-SHEET](PROOF-SHEET.md).

---

## 1. Centro conceptual — Memória Operacional

```text
                    CONDOMÍNIO
                        │
       ┌────────────────┼────────────────┐
       │                │                │
    Pessoas          Finanças        Governance
       │                │                │
       └────────────────┼────────────────┘
                        │
               MEMÓRIA OPERACIONAL
                        │
        ┌───────────────┼───────────────┐
        │               │               │
     Evidence       Provenance       Authority
        │               │               │
        └───────────────┼───────────────┘
                        │
                     Ledger
                        │
                    Workflows
                        │
                Deterministic Rules
                        │
                 AI Assistance
                        │
                Controlled Effects
```

A Orquestra (F6) é camada interpretativa subordinada. Cinco "agentes LLM" **não** são a arquitectura de negócio.

---

## 2. Capacidades de negócio ↔ fatias de produto

| Capacidade de negócio | O que entrega | Fatia | Estatuto (ver PROOF-SHEET) |
|-----------------------|---------------|-------|----------------------------|
| Plataforma multi-tenant + identidade | Isolamento, auth, Membership | F0 | Parcial / em evolução |
| **Data-to-State** (constituição) | Document → structure → semantic extract → canonical → validate → human review | F1 | Parcial — não "parser de PDFs" solto |
| Finance Kernel | Obligation/Payment/Allocation/Ledger | F2 | Parcial — kernel ≠ cutover ≠ negócio |
| Portal + convites | Activação condóminos, tickets, PWA | F3 | Parcial — depende de constituição real |
| Operações assistidas | Tickets/fornecedores/contratos leves | F4 | Freeze comercial no piloto |
| Governance | Reunião, voto, acta, ResolutionRule | F5 | Não operacional comercialmente |
| Orquestra | Assistência LLM multi-especialidade | F6 | Futuro |
| **Condominium Transition** | Source → baseline → reconstrução → reconciliação → shadow → cutover | F1+F2+Transplante | Não demonstrado ponta-a-ponta |
| Portabilidade / Exit | Exportação estruturada | Gates / ADR-037 | Especificado; operação a provar |
| Autonomia Tier 3 | Efeitos controlados sem humano | Pós-F6 | Futuro |

F1 é capacidade **Data-to-State**, não catálogo de parsers independentes (ADR-043/044).

---

## 3. Papéis e autoridade

| Papel empresarial | Responsabilidade | Autoridade de produto |
|-------------------|------------------|----------------------|
| Founder / ops piloto | Aceitar leads, assisted reports, office hours | Cap 4 assisted/mês; regras de gestão (07) |
| Champion do prédio | Empurrar deliberação | Não cria Membership sozinho |
| Admin do tenant | Confirma constituição, finanças, convites | Membership + AuthorityRule |
| Condómino | Consulta, tickets, (futuro) voto | Via Invitation |
| Fiscalização | Confirmar acções sensíveis | Role, não UI obrigatória (ADR-031) |
| DPO / legal | Gates de privacidade e liability | Fora do código; PRODUCTION-GATES |
| LLM / Orquestra | Hipóteses e assistência | Nunca confirma valores críticos nem dinheiro/votos |

---

## 4. Customer lifecycle

```text
Lead
  → Relatório (self-serve | assisted)
  → Champions
  → Assembleia / deliberação
  → Aceitação no piloto (critérios 07)
  → Transição Source→LUMEN
  → Activação (convites / portal)
  → Operação recorrente (Essencial)
  → Medição (utilização, suporte, contribuição)
  → Renovação paga
  → (opcional) Upgrade Profissional/Enterprise após gates
  → Tenant Exit / portabilidade
```

Cada etapa tem métrica (07/08) e evidência (PROOF-SHEET). Não saltar para "produção plena" sem [PRODUCTION-GATES](PRODUCTION-GATES.md).

---

## 5. Processo de transição (arquitectura empresarial)

```text
Source (pasta, admin anterior, Fonte, Excel, PDF)
        ↓
Baseline (autoridade do representante + finalidade + consentimento)
        ↓
Reconstruction (Data-to-State / F1)
        ↓
Reconciliation (F2 + relatório)
        ↓
Human confirmation (linha a linha / review)
        ↓
Shadow run (quando aplicável; sem dual-write obrigatório cedo)
        ↓
Cutover (LUMEN autoritativo no âmbito acordado)
```

Sem constituição confirmada (fracções, contactos, memberships), F3 **não** fecha o valor — o portal depende do estado real, não só de UI.

---

## 6. Informação e controlos

| Artefacto | Papel |
|-----------|-------|
| Constituição versionada | Quem é o condomínio |
| Ledger + hash-chain | Verdade financeira do produto |
| AuditEvent | Quem fez o quê |
| Evidence / Provenance | De onde veio cada facto |
| Approval | Compromissos versionados |
| Invitation | Acesso sem QR físico (ADR-001) |

Controlos de empresa: regras de gestão em 07; cap assisted; freeze F4–F6; PROOF-SHEET actualizado após trials.

---

## 7. Workflows críticos (empresa)

1. **Lead → relatório** — modos A/B; linguagem factual; sem overclaim.
2. **Deliberação → contrato comercial Essencial** — só com champion e assembleia.
3. **Onboarding / transição** — checklist de autoridade + Data-to-State + reconciliação.
4. **Suporte** — office hours; minutos registados por tenant (08).
5. **Incidente / excepção** — retrabalho e causa registados (alimenta unit economics).
6. **Renovação** — intenção ≠ pagamento utilizado.
7. **Exit** — exportação; não retaliar com lock-in.

---

## 8. Métricas operacionais

| Métrica | Para quê |
|---------|----------|
| Time to assembly / vote-yes / drop-off | Funil |
| Horas onboarding / minutos suporte / excepções | Custo de entrega |
| Tenants pagos / renovação | Negócio |
| % relatórios assisted vs self-serve | Productização |
| Contribuição por condomínio | Economia (08) |
| Itens PROOF-SHEET em "parcial" vs "demonstrado" | Honestidade comercial |

---

## 9. Suporte e compliance

- Suporte piloto: office hours, não 24/7.
- Compliance: PRODUCTION-GATES (Legal, Privacy/DPO, Accounting, Banking/Security, Liability) antes de produção plena.
- Dados: isolamento por tenant; retenção por tipo (ADR-030); Exit (ADR-037).

---

## 10. Produto / tecnologia (fronteira)

Este documento **não** duplica 02/03/06. Fronteira:

| Negócio (11) | Produto (02/06/F*) |
|--------------|-------------------|
| Capacidade "Data-to-State" | Pipeline ADR-043/044 |
| Transição comercial | Transplante + F1/F2 |
| Confiança ao cliente | LLM subordinado, gates |
| Freeze de investimento | Freeze de fatias |

---

## 11. Organização futura (não contratar cedo)

| Gatilho | Papel a considerar |
|---------|-------------------|
| F1 vertical verde + carga UI | 0.5 frontend (já em 07) |
| >10 pagos ou custo humano insustentável | Ops / customer success leve |
| Antes de F5 comercial | Legal retainer + DPO estável |
| Após unit economics positivo e SOM com dados | Vendas só com playbook medido |

Não contratar para escalar vendas antes de onboarding provado (regra de gestão 07).

---

## 12. Ligação ADR-045

ICP e operações do dia-a-dia optimizam-se para **autogestão assistida**. Qualquer piloto com administradora profissional trata-se como experimento explícito, com evidência no PROOF-SHEET — não como mudança silenciosa de canal.
