# LUMEN — Índice de Documentação

**Versão: v7.0 | Data: 2026-09-23 | Estado: ACEITE (reconciliação empresarial)**

Produto: **LUMEN** — plataforma de autogestão assistida para condomínios (propriedade horizontal em Portugal).

Este pacote é só documentação. Não há código de Orquestra (F6) antes de tenant e ingestão (F0/F1) estáveis.

> **Nota v7.0:** pacote empresarial reconciliado — [10-MODELO-NEGOCIO](10-MODELO-NEGOCIO.md), [07](07-BUSINESS-PLAN.md) v7, [11-ARQUITECTURA-NEGOCIO](11-ARQUITECTURA-NEGOCIO.md), [08](08-PLANO-FINANCEIRO.md) v7, [PROOF-SHEET](PROOF-SHEET.md), ADR-045. Não substitui a disciplina v6.1 (TBD financeiros, Fonte vs LUMEN, freeze de capacidade).

> **Nota complementar (v6.1):** ver [AUDITORIA-COMPLEMENTAR-V61](AUDITORIA-COMPLEMENTAR-V61.md) e ADRs 041–042 (convocatória por meio; `RecordingSegment`).

---

## Regra de precedência

### Técnica / produto

Se dois documentos se contradisserem em matéria de domínio, fatias ou arquitectura de produto:

**ADR-LOG (aceite) > 02-DOMINIO > 06-FATIAS > diagramas de arquitetura > resto**

O ADR-LOG regista o que foi decidido e porquê. Os outros ficheiros descrevem como isso se manifesta. Em caso de dúvida, não se inventa uma terceira regra — segue-se a precedência.

### Negócio / evidência comercial

Se o conflito for **só de negócio** (o que se pode prometer, precificar ou escalar):

**PROOF-SHEET (evidência) > narrativa em 10 / 07 / 08 / 11**

Evidência operacional e comercial prevalece sobre prosa aspiracional. Isto **não** derroga a precedência técnica acima.

---

## Veredicto GO / NO-GO (v6.1 — inalterado na substância)

| Critério | Veredicto | Notas |
|---|---|---|
| **F0** (Plataforma + Domain Kernel) — implementação após freeze v6.1 | **GO** | Critérios de conclusão e propriedades testáveis em `06-FATIAS.md` |
| **F1** (Ingestão + Constituição) — vertical slice após freeze v6.1 | **GO** | Só como fatia vertical; não em paralelo com F0 incompleto |
| **F2** (Financeiro / Ledger) | **GO depois de** F0 kernel + fatia F1 | Não começar o Finance Kernel sem Domain Kernel congelado e F1 a passar |
| **Lançamento piloto** | **GO = F0–F3 Essencial** | Capacidades Essencial (ver `06-FATIAS.md`). Votação não é critério do piloto |
| **Lançamento comercial geral** | **GO = F5 + Production Readiness Gates** | Votação + fluxo de Acta + gates em `PRODUCTION-GATES.md` |
| **Dinheiro / ops / legal em produção real** | **NO-GO** até aos gates | Pagamentos reais, decisões legais vinculativas e ops de produção só depois dos Production Readiness Gates |

Resumo: congelar a documentação v6.1 → implementar F0 e F1 → F2 → piloto Essencial (F0–F3) → F5 + gates → comercial geral. Sem atalhos para dinheiro, votos ou efeitos legais em produção.

**v7.0:** GO documental de fatia **não** implica capacidade comercial de onboarding/transição — ver [PROOF-SHEET](PROOF-SHEET.md).

---

## Índice do pacote

| # | Documento | Estado no pacote | Conteúdo |
|---|-----------|------------------|----------|
| — | [ADR-LOG](ADR-LOG.md) | Existe | Decisões de arquitetura fechadas; ler primeiro em caso de conflito (incl. ADR-045) |
| 00 | [Índice](00-INDICE.md) | Existe (este ficheiro) | Precedência, GO/NO-GO, mapa do pacote |
| 01 | [Constituição](01-CONSTITUICAO.md) | Stub mínimo | Leis, regulamento como dados, Person/Membership — detalhe em 02 |
| 02 | [Domínio](02-DOMINIO.md) | Existe | Bounded contexts, invariantes, entidades |
| 03 | [Orquestra](03-ORQUESTRA.md) | Existe | Especialidades LLM, maestro, validação em camadas |
| 04 | [Portas](04-PORTAS.md) | Existe | Ingestão admin, convite, PWA, design Sevilla, canais |
| 05 | [Transplante](05-TRANSPLANTE.md) | Stub mínimo | Órgãos da `dev`; inventário completo na fase de implementação / doc 09 |
| 06 | [Fatias F0–F6](06-FATIAS.md) | Existe | Roadmap, modelo de lançamento Opção A, critérios |
| 07 | [Business Plan](07-BUSINESS-PLAN.md) | Existe (v7.0) | Como vira empresa viável: GTM, horizontes, transição, regras de gestão |
| 08 | [Plano Financeiro](08-PLANO-FINANCEIRO.md) | Esqueleto auditável (v7.0) | Unit economics, CAC/SOM com TBD — sem conversões inventadas |
| 09 | `09-ANALISE-CODEBASE-E-PROMPTS-CURSOR.md` | **FORA DESTE PACOTE** | A incorporar quando for implementar (análise do codebase + prompts) |
| 10 | [Modelo de Negócio](10-MODELO-NEGOCIO.md) | Existe (v7.0) | Como cria, entrega e captura valor |
| 11 | [Arquitectura do Negócio](11-ARQUITECTURA-NEGOCIO.md) | Existe (v7.0) | Capacidades, lifecycle, transição, papéis, métricas |
| — | [PROOF-SHEET](PROOF-SHEET.md) | Existe (v7.0) | Matriz Business → Product → Evidence; trials operacionais |
| — | [PRODUCTION-GATES](PRODUCTION-GATES.md) | Existe | Gates obrigatórios antes de dinheiro/ops/legal em produção e de lançamento comercial geral |
| — | [AUDITORIA-V61](AUDITORIA-V61.md) | Existe | Auditoria de consistência v6.1 |
| — | [AUDITORIA-COMPLEMENTAR-V61](AUDITORIA-COMPLEMENTAR-V61.md) | Existe | Análise complementar (convocatória, RecordingSegment); v6.1 permanece fechada |
| — | [AUDITORIA-ALINHAMENTO-PRODUTO](AUDITORIA-ALINHAMENTO-PRODUTO.md) | Existe | Auditoria de alinhamento `produto` vs v6.1 |
| — | [Diagramas de Arquitetura](LUMEN-diagramas-arquitetura.md) | Existe | Mermaid: domínio, onboarding, sequências, roadmap |
| — | [F1-IMPLEMENTACAO](F1-IMPLEMENTACAO.md) | Implementação | Upload, revisão linha a linha, pipeline ADR-043, perfis ADR-044 |
| — | [F1-INGEST-EXEMPLOS](F1-INGEST-EXEMPLOS.md) | Arquitectura F1 | 10 representações → o mesmo `CondominiumUnit` |
| — | [F1-INGEST-CORPUS](F1-INGEST-CORPUS.md) | Arquitectura F1 | Corpus multi-perfil (ADR-044); mapa de dívidas é falso positivo de `budget_plan` |
| — | [F2-IMPLEMENTACAO](F2-IMPLEMENTACAO.md) | Implementação | Finance Kernel + banking — honesty: não é negócio validado |
| — | [F3-IMPLEMENTACAO](F3-IMPLEMENTACAO.md) | Implementação | Invitation + portal Ledger + PWA (SW/offline/install) + spike iOS push FRAGILE |

### Papéis dos documentos empresariais (v7)

| Doc | Pergunta |
|-----|----------|
| **10** Modelo de Negócio | Como cria, entrega e captura valor? |
| **07** Business Plan | Como transformamos o modelo numa empresa viável? |
| **11** Arquitectura do Negócio | Como a empresa tem de funcionar para entregar? |
| **08** Plano Financeiro | Com que números (e TBD) medimos economia? |
| **PROOF-SHEET** | O que está realmente demonstrado? |

---

## Nota de execução

Documentação primeiro. Código de plataforma (tenant, auth, ingestão) só depois do freeze v6.1. Código da Orquestra LLM não antes de tenant + ingestão.

### Estado documental ≠ estado operacional ≠ validação de negócio

Os veredictos deste índice dizem respeito à especificação e às condições de avanço. Não certificam a implementação integrada nem o cumprimento dos gates de produção.

[F1-IMPLEMENTACAO](F1-IMPLEMENTACAO.md), [F2-IMPLEMENTACAO](F2-IMPLEMENTACAO.md) e [F3-IMPLEMENTACAO](F3-IMPLEMENTACAO.md) reportam capacidades e limites de recortes de implementação. As auditorias referem-se às branches, commits e datas nelas identificados; não constituem, por si só, uma verificação do código actual.

Validar o negócio exige evidência separada de compra, resultado utilizado, custo de entrega e renovação — registada em [PROOF-SHEET](PROOF-SHEET.md). Concluir F0–F6 não demonstra essas propriedades.
