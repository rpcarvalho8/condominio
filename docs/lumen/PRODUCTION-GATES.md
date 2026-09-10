# Production Readiness Gates

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Gates obrigatórios **antes** de dinheiro real, votos com efeitos, ou actos com consequências legais em produção multi-tenant.  
> **Profissionais (advogado, DPO, contabilista, segurança) são gates — não designers do produto.** Validam e assinam critérios; não redesenham o LUMEN no Miro.

Narrativa comercial e limites de autonomia: [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md). Domínio: [02-DOMINIO](02-DOMINIO.md). Orquestra: [03-ORQUESTRA](03-ORQUESTRA.md).

## Regra geral

Nenhum tenant pago em modo "produção plena" (para além do piloto controlado) sem os cinco blocos abaixo em estado **PASS** ou **WAIVED com justificação escrita e prazo**.

Piloto pode operar com âmbito reduzido (ex.: Essencial, sem votação) **desde que** os gates do âmbito activo estejam cobertos.

---

## 1. Legal

| Gate | Critério (resumo) | Owner profissional |
|------|-------------------|--------------------|
| Actas | Máquina de estados, aprovação por condóminos/`ResolutionRule`, assinatura vs subscrição, dois hashes; Risk Engine **não** aprova Acta | Advogado |
| Votação | Quórum/maioria via `ResolutionRule`; ponderação por permilagem; auditabilidade do voto | Advogado |
| ResolutionRules | Seed legal + regulamento mais exigente; hierarquia lei > … documentada | Advogado |
| Poderes / Authority | Quem pode autorizar o quê (`AuthorityRule` / roles); human override | Advogado |
| Convocatórias / avisos | Prazos e canais mínimos legais respeitados ou explicitamente fora de âmbito | Advogado |

**FAIL se:** LLM ou Risk Engine aparecerem como decisor de deliberação ou de validade jurídica da Acta.

---

## 2. Privacy / DPO (RGPD)

| Gate | Critério (resumo) | Owner profissional |
|------|-------------------|--------------------|
| Bases legais / consentimentos | Finalidades claras; bases documentadas | DPO / advogado privacidade |
| Documentos pessoais | Classificação, acesso mínimo, retenção distinta de docs "legais do condomínio" | DPO |
| Áudio | Minimização; hard-delete após pipeline (acta/reunião); prazos confirmados | DPO |
| Retenção | Políticas por tipo de dado; não "guardar tudo para sempre" | DPO |
| Acesso | Membership-based; sem QR físico; step-up em ações sensíveis | DPO + eng |
| Exportação / apagamento | Tenant Exit / portabilidade e direitos do titular (acesso, apagamento onde aplicável) | DPO |

---

## 3. Accounting

| Gate | Critério (resumo) | Owner profissional |
|------|-------------------|--------------------|
| Dinheiro (cash) | `cash_status`: `registered` → `verified` → `deposited`; `verification_method`: `second_person` (role `Fiscalizacao`, registante ≠ verificador) ou `bank_deposit`; evidência fotográfica; Obligation nunca liquidada só em `registered` | Contabilista / admin piloto |
| Recibos / avisos | Gerados a partir do Ledger / Obligations — nunca fonte de verdade invertida | Contabilista |
| Reconciliação | Linguagem factual; pendências visíveis; sem alocação às cegas | Contabilista + eng |
| Períodos | `AccountingPeriod` com Posted / Pending / Adjustments distintos | Contabilista |
| Reporting | Totais reconciliáveis por soma do Ledger; hash-chain como evidência de integridade | Contabilista + eng |

---

## 4. Banking / Security

| Gate | Critério (resumo) | Owner profissional |
|------|-------------------|--------------------|
| BankConnection | Ligada à conta do condomínio; ciclo de vida / reautorização | Eng + revisão segurança |
| PSD2 / Open Banking | Consentimentos, scopes, falhas e fallback CSV | Eng + fornecedor |
| Auth | Sessão ↔ Membership; revogação imediata; isolamento tenant | Segurança / eng |
| Recovery | Backup/restore de tenant testado; secrets fora de logs | Eng |
| Superfície de ataque | Sem IDs previsíveis em convites; rate limits; falha fechada sem tenant | Segurança |

---

## 5. Liability

| Gate | Critério (resumo) | Owner profissional |
|------|-------------------|--------------------|
| Responsabilidade | Termos / disclaimer: LUMEN assiste; decisões no órgão competente | Advogado |
| Seguro | RC admin autogerido = add-on a **validar** (não assumir) | Negócio + seguradora |
| Limites de autonomia | LLM nunca decide dinheiro/votos; approval gates; human override | Produto + advogado |
| Escalações | Caminho claro para humano/advogado real em risco elevado | Produto |

---

## Checklist rápido antes de "ir a dinheiro / votos"

- [ ] Legal PASS para o âmbito (Essencial vs Profissional com atas/votos)
- [ ] Privacy/DPO PASS (áudio, docs, export/erasure)
- [ ] Accounting PASS (cash, recibos, períodos)
- [ ] Banking/Security PASS (BankConnection, auth, restore)
- [ ] Liability PASS (termos, autonomia, seguro em curso de validação se prometido)

Distribuição além do piloto e venda de Profissional/Enterprise: ver regra de capacidade e pricing em [07-BUSINESS-PLAN](07-BUSINESS-PLAN.md).
