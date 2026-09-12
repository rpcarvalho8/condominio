# LUMEN — Índice de Documentação

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

Produto: **LUMEN** — plataforma de autogestão assistida para condomínios (propriedade horizontal em Portugal).

Este pacote é só documentação. Não há código de Orquestra (F6) antes de tenant e ingestão (F0/F1) estáveis.

> **Nota complementar (v6.1):** ver [AUDITORIA-COMPLEMENTAR-V61](AUDITORIA-COMPLEMENTAR-V61.md) e ADRs 041–042 (convocatória por meio; `RecordingSegment`).

---

## Regra de precedência

Se dois documentos se contradisserem, a autoridade segue esta ordem:

**ADR-LOG (aceite) > 02-DOMINIO > 06-FATIAS > diagramas de arquitetura > resto**

O ADR-LOG regista o que foi decidido e porquê. Os outros ficheiros descrevem como isso se manifesta. Em caso de dúvida, não se inventa uma terceira regra — segue-se a precedência.

---

## Veredicto GO / NO-GO (v6.1)

| Critério | Veredicto | Notas |
|---|---|---|
| **F0** (Plataforma + Domain Kernel) — implementação após freeze v6.1 | **GO** | Critérios de conclusão e propriedades testáveis em `06-FATIAS.md` |
| **F1** (Ingestão + Constituição) — vertical slice após freeze v6.1 | **GO** | Só como fatia vertical; não em paralelo com F0 incompleto |
| **F2** (Financeiro / Ledger) | **GO depois de** F0 kernel + fatia F1 | Não começar o Finance Kernel sem Domain Kernel congelado e F1 a passar |
| **Lançamento piloto** | **GO = F0–F3 Essencial** | Capacidades Essencial (ver `06-FATIAS.md`). Votação não é critério do piloto |
| **Lançamento comercial geral** | **GO = F5 + Production Readiness Gates** | Votação + fluxo de Acta + gates em `PRODUCTION-GATES.md` |
| **Dinheiro / ops / legal em produção real** | **NO-GO** até aos gates | Pagamentos reais, decisões legais vinculativas e ops de produção só depois dos Production Readiness Gates |

Resumo: congelar a documentação v6.1 → implementar F0 e F1 → F2 → piloto Essencial (F0–F3) → F5 + gates → comercial geral. Sem atalhos para dinheiro, votos ou efeitos legais em produção.

---

## Índice do pacote

| # | Documento | Estado no pacote | Conteúdo |
|---|-----------|------------------|----------|
| — | [ADR-LOG](ADR-LOG.md) | Existe | Decisões de arquitetura fechadas; ler primeiro em caso de conflito |
| 00 | [Índice](00-INDICE.md) | Existe (este ficheiro) | Precedência, GO/NO-GO, mapa do pacote |
| 01 | [Constituição](01-CONSTITUICAO.md) | Stub mínimo | Leis, regulamento como dados, Person/Membership — detalhe em 02 |
| 02 | [Domínio](02-DOMINIO.md) | Existe | Bounded contexts, invariantes, entidades |
| 03 | [Orquestra](03-ORQUESTRA.md) | Existe | Especialidades LLM, maestro, validação em camadas |
| 04 | [Portas](04-PORTAS.md) | Existe | Ingestão admin, convite, PWA, design Sevilla, canais |
| 05 | [Transplante](05-TRANSPLANTE.md) | Stub mínimo | Órgãos da `dev`; inventário completo na fase de implementação / doc 09 |
| 06 | [Fatias F0–F6](06-FATIAS.md) | Existe | Roadmap, modelo de lançamento Opção A, critérios |
| 07 | [Business Plan](07-BUSINESS-PLAN.md) | Existe | Posicionamento, GTM, tiers, checklist founder |
| 08 | [Plano Financeiro](08-PLANO-FINANCEIRO.md) | Esqueleto auditável | Grelhas CAC/custos/SOM com TBD pós-piloto — sem conversões inventadas |
| — | [PRODUCTION-GATES](PRODUCTION-GATES.md) | Existe | Gates obrigatórios antes de dinheiro/ops/legal em produção e de lançamento comercial geral |
| — | [AUDITORIA-V61](AUDITORIA-V61.md) | Existe | Auditoria de consistência v6.1 |
| — | [AUDITORIA-COMPLEMENTAR-V61](AUDITORIA-COMPLEMENTAR-V61.md) | Existe | Análise complementar (convocatória, RecordingSegment); v6.1 permanece fechada |
| — | [AUDITORIA-ALINHAMENTO-PRODUTO](AUDITORIA-ALINHAMENTO-PRODUTO.md) | Existe | Auditoria de alinhamento `produto` vs v6.1 |
| — | [Diagramas de Arquitetura](LUMEN-diagramas-arquitetura.md) | Existe | Mermaid: domínio, onboarding, sequências, roadmap |
| — | [F3-IMPLEMENTACAO](F3-IMPLEMENTACAO.md) | Implementação | Invitation + portal saldo Ledger / documentos F2; fronteira vs PWA |
| 09 | `09-ANALISE-CODEBASE-E-PROMPTS-CURSOR.md` | **FORA DESTE PACOTE** | A incorporar quando for implementar (análise do codebase + prompts) |

---

## Nota de execução

Documentação primeiro. Código de plataforma (tenant, auth, ingestão) só depois do freeze v6.1. Código da Orquestra LLM não antes de tenant + ingestão.
