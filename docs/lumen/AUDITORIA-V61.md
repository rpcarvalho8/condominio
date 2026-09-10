# AUDITORIA-V61 — Consistency Hardening

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

Auditoria adversarial após aplicar o hardening. Precedência: **ADR-LOG > 02-DOMINIO > 06-FATIAS > diagramas > resto**.

---

## A. Alterações implementadas

| Ficheiro | O que mudou |
|----------|-------------|
| `00-INDICE.md` | Precedência, GO/NO-GO piloto vs comercial, índice sem ficheiros fantasma, pacote v6.1 |
| `01-CONSTITUICAO.md` | Stub mínimo alinhado (constituição como dados, Person/Membership, lei>regulamento) |
| `02-DOMINIO.md` | Roles com `Fiscalizacao`; cash `cash_status`+`verification_method`; hash-chain rigorosa sem overclaim; Acta até `PUBLISHED`; snapshots; retenção; Tenant Exit; invariantes |
| `03-ORQUESTRA.md` | Legal KB tipada; Risk Engine não aprova Actas; LLM fora do core financeiro/governação; email observável ≠ inbox garantida; IoT Tier 3 |
| `04-PORTAS.md` | Contact verification; piloto vs comercial; lista móvel sem voto até F5; lead magnet A/B; retenção IBAN |
| `05-TRANSPLANTE.md` | Stub: órgãos da `dev`, Fonte ≠ LUMEN multi-tenant |
| `06-FATIAS.md` | Opção A (piloto/comercial); F0 async+Fiscalizacao; F2 cash; F3 kit assembleia; F5 Acta; capacity freeze; PRODUCTION-GATES |
| `07-BUSINESS-PLAN.md` | Funil assembleia; SAM hipótese; liability #8; pricing/F5; IoT fora; portabilidade; Fonte vs LUMEN; checklist founder |
| `08-PLANO-FINANCEIRO.md` | Esqueleto auditável com TBD (sem conversões inventadas) |
| `ADR-LOG.md` | Emendas 001/006/011/012/026–035; novos ADR-036…040 |
| `PRODUCTION-GATES.md` | Gates Legal / Privacy / Accounting / Banking / Liability |
| `LUMEN-diagramas-arquitetura.md` | Fiscalizacao, hash-chain, Acta sem Risk Engine, cash canónico, gates piloto/comercial |
| `AUDITORIA-V61.md` | Este relatório |

---

## B. Pontos em que discordámos do prompt GPT (ou limitámos)

| Conclusão GPT | Posição v6.1 | Porquê / alternativa |
|---------------|--------------|----------------------|
| Opção B (comercial geral só com F5) como única | **Opção A refinada** | Piloto Essencial (F0–F3 sem voto) é coerente; comercial geral gated por F5 + gates |
| % universal de aprovação da Acta | **Rejeitada** | `ResolutionRule` + lei/regulamento + gate advogado; sem inventar lei |
| Checkpoint / âncora externa no core hash-chain | **Future Decision** | Útil contra atacante que reescreve a BD; não é necessário para F2 |
| Identity verification verdadeira no MVP | **Fora** | Contact verification + validação admin Pessoa↔Fração↔Membership |
| Expandir arquitectura por entusiasmo | **Fora** | v6.1 = consistency hardening, não nova arquitectura |
| “Email garantido” no sentido de entrega ao utilizador | **Rejeitada** | Email = canal primário com envio/retry/estado/observabilidade; inbox fora do nosso controlo |

---

## C. Problemas novos encontrados (e correcção)

| Problema | Correcção |
|----------|-----------|
| Pacote zip referenciava 01/05/08/09 inexistentes | Stubs 01/05 + esqueleto 08; 09 marcado fora do pacote |
| Diagramas 3.3 usavam `registado/confirmado` e `verification_method=fiscalizacao` | Alinhados a `registered/verified/deposited` + `second_person\|bank_deposit` |
| PRODUCTION-GATES cash em português legado | Alinhado ao modelo canónico inglês de estados |
| Orquestra ainda dizia email “garantido” | Reformulado para observabilidade sem promessa de inbox |
| Índice listava AUDITORIA antes de existir | Este ficheiro fecha o loop |
| Versões misturadas v3–v6 no pacote original | Uniformizado **v6.1** + data 2026-09-10 |
| Business plan misturava BuildingMind como marca activa | LUMEN primario; BuildingMind = nome antigo |
| IoT no tier Enterprise | Removido do comercial → Tier 3 Future |
| Checklist founder sem critério champion/≤60 dias | Acrescentado em `07` + WIP limit em `06` |

### Future Decisions (registadas, não introduzidas no core)

- Checkpoint / âncora externa do Ledger
- KYC / verificação de identidade civil
- Assinatura electrónica qualificada / declaração electrónica na Acta (domínio já preparado; MVP físico primeiro)
- IoT / estacionamento
- Marketplace de fornecedores autónomo / procurement Tier 3
- Doc `09` (análise codebase + prompts) na fase de implementação

---

## D. Estado final GO / NO-GO

| Área | Veredicto | Porquê (curto) |
|------|-----------|----------------|
| **F0** | **GO** | Domain Kernel, Roles (incl. Fiscalizacao), Events/Jobs/Audit, async idempotente, TenantDirectory — especificação implementável |
| **F1** | **GO** | Ingestão + constituição como vertical slice; gates humanos em OCR/convites definidos |
| **F2** | **GO** (após F0+F1) | Cash/hash-chain/Ledger/BankConnection especificados; não começar sem kernel |
| **F3** | **GO** como contrato de piloto | Onboarding por convite + PWA Essencial; **sem** votação como critério; spike iOS push obrigatório antes de fechar F3 |
| **F4** | **Contrato** / freeze no piloto | Ops/orçamentos — não distribuir além do piloto até F0–F2 estáveis / 10 pagos |
| **F5** | **Contrato** / gate comercial | Acta+voto necessários ao comercial geral; validação advogado antes de produção |
| **F6** | **NO-GO implementação** | Orquestra só depois de tenant+ingestão; LLM nunca no caminho crítico de saldo/voto |
| **Production (dinheiro/votos/legal)** | **NO-GO** | Exige Production Readiness Gates PASS (ou WAIVED justificado) |
| **Pilot launch (Essencial)** | **GO documental** | Critérios claros; execução de código ainda por fazer |
| **General commercial launch** | **NO-GO** | F5 + gates + liability/seguro a validar |

---

## E. Última regra

Não expandir a arquitectura por entusiasmo. Decisões maduras foram fechadas (ADR-036…040 + emendas). Melhorias futuras ficam como Future Decision. O objectivo desta ronda era **v6.1 — consistency hardening**, não uma arquitectura nova.

### Checklist adversarial (segunda passagem)

| Tema | Resultado |
|------|-----------|
| Contradições F3 vs F5 lançamento | Resolvidas (Opção A) |
| Roles sem Fiscalizacao | Resolvido |
| Cash Admin→Admin | Proibido; second_person ou bank_deposit |
| Hash-chain overclaim | Reformulado (tamper evidence) |
| Acta approval ≠ signature ≠ subscription ≠ vote ≠ presence | Explícito + PUBLISHED |
| Contact ≠ identity | Explícito |
| Finance/gov sem LLM | Invariante + F0 testável |
| PWA comercial | ADR-035 + lista alinhada |
| Async F0 | ADR-038 |
| Portability | ADR-037 |
| Liability + gates | 07 + PRODUCTION-GATES |
| Diagramas vs prosa | Alinhados na segunda passagem |
| História / Membership mudando | Snapshots Participante/voto |
| Obligation ≠ Payment ≠ Allocation ≠ Ledger | Mantido |
| 09 ausente | Assinalado, não inventado |

### Checklist founder (negócio — não código)

Ver secção correspondente em `07-BUSINESS-PLAN.md`: champion + assembleia ≤60 dias; inquérito SAM; preencher 08 com números reais; advogado/seguro; vender só Essencial no piloto; frase Fonte vs LUMEN; máx. 4 relatórios assistidos/mês; WIP/capacidade; 0.5 frontend só após F1 verde.
