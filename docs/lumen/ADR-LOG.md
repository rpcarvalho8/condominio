# ADR-LOG — Registo de Decisões de Arquitetura (LUMEN)

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Formato leve, não processo pesado: uma entrada por decisão, decisão + estado + justificação + o que fica em aberto. Objetivo é impedir que o projeto se torne um conjunto de documentos contraditórios à medida que cresce — não burocratizar decisões de 1 founder.
>
> **Nota complementar (v6.1):** ADRs 041–042 (convocatória por meio por condómino; `Reuniao` contínua + `RecordingSegment`). Estado ACEITE para arquitectura de produto; itens legais abertos assinalados como *legal validation required*.
>
> Estado possível: `ACEITE` (construir assim), `ACEITE — validar antes de produção` (a direção está certa, mas há um parâmetro concreto a confirmar com um profissional antes de ir a produção), `FECHADA — não reabrir` (decisão definitiva, não voltar a discutir sem novo facto material).

## Regra de Precedência (para quem implementa)

Se qualquer documento contradizer outro — e vai acontecer, à medida que o projeto envelhece — a ordem de autoridade é:

**ADR-LOG (aceite) > 02-DOMINIO > 06-FATIAS > diagramas de arquitetura > qualquer outro texto**

Concretamente: se um agente de código (Claude, Codex, ou humano) encontrar "QR batch" ou "retenção de 10% sobre pagamento" nalgum ficheiro, isso **não é a especificação atual** — é texto que uma revisão posterior já invalidou. O ADR-LOG é sempre a fonte de verdade sobre *o que foi decidido e porquê*; os outros documentos descrevem *como isso se manifesta*, e podem ficar temporariamente desatualizados entre revisões sem que isso mude a decisão.

---

## ADR-001 — Remoção do QR Físico como Mecanismo de Acesso

**Estado:** FECHADA — não reabrir.

**Decisão:** o produto não usa, em nenhuma circunstância, QR Code impresso e afixado (zona comum, fração, hall) nem QR reencaminhável por email/foto como credencial de acesso, autenticação ou identificação do condómino. O onboarding do condómino é sempre por **Convite individual** (`Invitation`): privado, de uso único, revogável, com **verificação de contacto** (prova de posse de email/telefone) antes de criar `Membership`.

**Emenda v6.1:** o fluxo de Convite faz **verificação de contacto**, **não verificação de identidade civil** (Cartão de Cidadão, biometria, KYC bancário, etc.). Linguagem anterior que falava em "verificação de identidade/contacto" era ambígua e fica corrigida: o produto prova que o destinatário controla o canal de contacto usado no convite; não afirma ter verificado a identidade legal da pessoa.

**Justificação:** um QR físico ou reencaminhável é um segredo de autenticação exposto fisicamente — mesmo com expiração de 90 dias, a janela de exposição é grande e incontrolável (fotografado, reenviado, deixado visível). Isto tocaria em saldo, dívidas, votação e documentos legais.

**Exceção permitida:** o link de um Convite já emitido pode, opcionalmente, ser também apresentado como QR **dentro do próprio email/SMS** enviado ao destinatário certo — nunca impresso, nunca afixado, nunca reutilizável. Isto não é uma reabertura da decisão, é apenas uma codificação alternativa do mesmo link privado e de uso único.

**Impacto:** 04-PORTAS, 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS, 07-BUSINESS-PLAN, 05-TRANSPLANTE, diagrama de arquitetura e diagramas de onboarding — todos atualizados.

---

## ADR-002 — Fundo Comum de Reserva (FCR) é Obligation, não Retenção Percentual

**Estado:** ACEITE.

**Decisão:** o FCR é calculado no orçamento anual como uma `Obligation` própria (pelo menos 10% da quota-parte do condómino nas despesas do condomínio, art. 4.º DL 268/94), cobrada como qualquer outra rubrica. **Nunca** se retêm 10% de cada pagamento recebido.

**Justificação:** a leitura anterior ("10% de cada pagamento") não corresponde à lei nem à jurisprudência (TRP), e teria retido dinheiro incorretamente sempre que um condómino pagasse valores parciais ou avulsos.

**Impacto:** 02-DOMINIO (Obligation, invariante 2), 03-ORQUESTRA, 06-FATIAS (F1, F2), diagrama de arquitetura (sequência 3.3).

---

## ADR-003 — Modelo Financeiro: Obligation / Payment / Allocation / Ledger

**Estado:** ACEITE.

**Decisão:** substitui `Quota.pago: boolean` por `Obligation` (o que é devido), `Payment` (o que foi recebido), `Allocation` (a ligação entre os dois) e um `Ledger` append-only (nunca se edita uma alocação passada, só se lança um ajuste).

**Justificação:** um boolean não sobrevive a pagamento parcial, pagamento em excesso, reversão, ou disputa sobre "porque é que esta fração deve X". O Ledger torna o saldo sempre reconstruível por soma, auditável em caso de litígio.

**Impacto:** 02-DOMINIO, 06-FATIAS (F2), diagrama de arquitetura (sequência 3.3).

---

## ADR-004 — SettlementPolicy Separa Regra Legal de Preferência de Admin

**Estado:** ACEITE.

**Decisão:** a ordem de imputação de um pagamento contra obrigações em aberto é uma `SettlementPolicy` versionada, com `legal_basis`. O admin configura preferências **dentro** do que a política permite — nunca decide, por configuração, o que é legalmente devido.

**Justificação:** um `CascataConfig` simples, sem esta separação, dava ao admin o poder de reordenar obrigações de forma que poderia não ser legalmente válida sem perceber a implicação.

**Impacto:** 02-DOMINIO.

---

## ADR-005 — Quórum e Maioria via ResolutionRule, não Invariante Hardcoded

**Estado:** ACEITE.

**Decisão:** quórum e maioria de uma `Deliberacao` são resolvidos por `ResolutionRule` (tipo de deliberação → base legal → regulamento do condomínio, se mais exigente), com seed inicial a partir do art. 1432.º. Deixa de existir a regra fixa ">50% 1ª conv, qualquer 2ª" hardcoded no código.

**Justificação:** nem todas as deliberações têm o mesmo regime de maioria, e o regulamento de um condomínio pode ser mais exigente que a lei — hardcodar uma percentagem universal estava errado para o caso geral.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F5), diagrama de arquitetura (sequência 3.1).

---

## ADR-006 — Identidade via Person + Membership, não user.role Fixo

**Estado:** ACEITE (implementação faseada — não construir todos os roles agora).

**Decisão:** identidade é `Person` (pode ter várias `Membership`s) + `Membership` (liga Person, Tenant, Fração opcional, e Role) + `Role` extensível. Conjunto inicial real: `Owner`, `CoOwner`, `Proxy`, `Admin`, `PlatformAdmin`, **`Fiscalizacao`**. Outros papéis (Accountant, Lawyer, Technician, CommitteeMember) ficam previstos na estrutura mas não implementados até haver utilizador real para eles.

**Emenda v6.1 (ADR-006b / inline):** o conjunto inicial **inclui** `Fiscalizacao` desde o arranque do modelo (alinhado a ADR-031). Não é entidade `ConselhoFiscal` nem UI obrigatória — é um Role de capacidade de controlo (confirmar ações sensíveis, não criar). Não é obrigatório atribuir o role a ninguém num tenant concreto.

**Justificação:** um enum fixo de 3 valores (`super_admin/admin/condómino`) não sobrevive ao primeiro caso real de alguém com múltiplos papéis em múltiplos tenants/frações. Incluir `Fiscalizacao` no conjunto inicial evita retrofit quando o controlo de dinheiro (ADR-028) e outras confirmações sensíveis entrarem em F2.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 04-PORTAS, 06-FATIAS (F0), diagrama de arquitetura.

---

## ADR-007 — RAG Nunca é Fonte de Verdade para Factos Financeiros

**Estado:** ACEITE.

**Decisão:** perguntas sobre saldo/dívida são sempre resolvidas via Domain Services → Ledger, nunca via embedding/RAG. RAG serve exclusivamente perguntas qualitativas (ex: "o que diz o regulamento sobre animais?").

**Justificação:** um LLM a responder um valor financeiro a partir de uma representação semântica introduz risco de alucinação num domínio onde o erro tem custo real e imediato de confiança.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, diagrama de arquitetura.

---

## ADR-008 — Validação em Camadas Substitui "Jurídico Decide Sozinho"

**Estado:** ACEITE.

**Decisão:** nenhuma ação sai do sistema aprovada por um único LLM. Passa por Schema Validation + Domain Rules Validation (determinística) + Legal Interpretation (LLM, consultivo) → Risk Engine determinístico decide AUTO / Aprovação do admin / Escalação humana-legal.

**Justificação:** um LLM Jurídico como porteiro único é single point of failure e pode alucinar; uma regra determinística não alucina.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 04-PORTAS, 06-FATIAS (F6), diagrama de arquitetura.

---

## ADR-009 — Domain Kernel (Events/Jobs/Audit/Policy) Constrói-se em F0, não em F6

**Estado:** ACEITE.

**Decisão:** infraestrutura de Domain Events, Job Queue, Audit Log e o esqueleto do Policy Engine fazem parte de F0, não são adiados para a Orquestra LLM (F6).

**Justificação:** construir isto só em F6 obrigaria a refatorar F1-F5 para o adicionar depois — mais barato desde o início.

**Impacto:** 06-FATIAS (F0), diagrama de arquitetura, backlog imediato.

---

## ADR-010 — Domain Services entre API e Repositories

**Estado:** ACEITE.

**Decisão:** rotas Hono (API) nunca contêm lógica de negócio — chamam Application Services (Use Cases) que chamam Domain Services (regras de negócio: `SettlementEngine`, `ResolutionRuleEngine`) que chamam Repositories (Drizzle).

**Justificação:** sem esta camada explícita, "Clean Architecture" era só uma palavra no prompt, não uma propriedade real do código — a lógica de negócio acabava a viver nas rotas.

**Impacto:** diagrama de arquitetura (Diagrama 1), 06-FATIAS (F0).

---

## ADR-011 — Retenção de Áudio: Direção Aceite, Prazo a Validar

**Estado:** ACEITE — validar antes de produção.

**Decisão:** áudio de Assembleia é eliminado após a Ata ser aprovada (`APPROVED`); áudio de Reuniões Admin é eliminado logo após o resumo. A direção (minimização de dados, o documento escrito é a referência, não a gravação) está correta. Se o fluxo ficar preso após `APPROVED`, retry + alerta + eliminação forçada com `AuditEvent`.

**Em aberto:** o prazo operacional exato (ex: "24-48h") não deve ser tratado como regra jurídica fixa sem confirmação com um advogado/DPO — a captação de som tem enquadramento específico em Portugal que precisa de validação caso a caso antes de ir a produção.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4, F5), diagrama de arquitetura.

---

## ADR-012 — Payment é Válido Sem Allocation (Estados Explícitos)

**Estado:** ACEITE.

**Decisão:** `Payment` tem estados explícitos de alocação (`identificado` / `parcialmente_alocado` / `totalmente_alocado` / `não_alocado_pendente`) e é uma entidade financeiramente válida mesmo sem nenhuma `Allocation` associada — pode existir e ser reportado nesse estado indefinidamente sem bloquear nada. Estes estados são **ortogonais** a `cash_status` (ADR-028).

**Justificação:** o modelo anterior implicava que Payment e Allocation nasciam juntos; isso é inconsistente com a própria regra de que o fecho de mês nunca bloqueia nem esconde pendências.

**Impacto:** 02-DOMINIO.

---

## ADR-013 — Ledger → AccountingPeriod é Unidirecional

**Estado:** ACEITE.

**Decisão:** `AccountingPeriod` é uma camada de reporting/fecho **sobre** o Ledger, nunca uma segunda fonte de verdade financeira. Fluxo sempre `Ledger → AccountingPeriod → Reports/Statements`, nunca o inverso.

**Justificação:** sem esta declaração explícita, correções pós-fecho, reversões e reclassificações futuras arriscavam criar duas verdades financeiras divergentes.

**Impacto:** 02-DOMINIO.

---

## ADR-014 — BankConnection Ligada à Conta do Condomínio, Não ao Admin

**Estado:** ACEITE.

**Decisão:** a autorização bancária (Enable Banking/PSD2) é modelada como `BankConnection`, associada à conta bancária do condomínio, nunca à pessoa do admin. Renovação técnica de tokens é automática (responsabilidade do provider); o sistema só pede intervenção humana quando o consentimento do utilizador realmente expira, avisando antes do prazo.

**Justificação:** ligar a autorização à pessoa do admin partiria a integração financeira sempre que o administrador mudasse — um evento normal e frequente.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F2).

---

## ADR-015 — FinancialDocument Nunca é Fonte de Verdade

**Estado:** ACEITE.

**Decisão:** documentos financeiros (`PaymentNotice`/Aviso de Débito, `Receipt`/Recibo, `AccountStatement`/Extrato) são sempre representações imutáveis, reconstruíveis a partir de Obligation/Payment/Allocation/Ledger via `generated_from`. Nunca "fotografias soltas" de dados de um momento. Um Aviso de Débito não cria a obrigação que descreve — a obrigação deriva sempre de uma deliberação/orçamento já aprovado.

**Justificação:** sem esta regra, um recibo histórico poderia divergir silenciosamente do Ledger se algo mudasse depois; e um sistema que "inventa" obrigações a cobrar, em vez de as documentar, teria problema legal sério.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F2).

---

## ADR-016 — Tenant Directory / Platform DB Elevado a Requisito F0

**Estado:** ACEITE.

**Decisão:** um registo central (fora das BDs de tenant) de metadados operacionais — provisionamento, migrations, backups, restore-test, secrets, observabilidade — é requisito explícito de F0, não melhoria arquitetural futura.

**Justificação:** DB-per-tenant reduz risco de fuga de dados entre condomínios, mas multiplica a superfície operacional por N bases de dados. Sem um diretório central desde o início, isto não escala de forma gerível.

**Impacto:** 02-DOMINIO, 06-FATIAS (F0), diagrama de arquitetura.

---

## ADR-017 — Onboarding em Massa: Confirmação Obrigatória Antes do Envio

**Estado:** ACEITE — reafirma ADR-001, não a reabre.

**Decisão:** depois de importar contactos (OCR/LLM), o sistema mostra sempre uma tabela de pré-visualização (fração ↔ pessoa ↔ contacto) para o admin confirmar/corrigir antes de qualquer `Invitation` ser criada ou enviada. Nunca dispara convites automaticamente a partir do resultado bruto do OCR.

**Justificação:** uma fotografia pode ter nomes trocados, emails mal lidos, fração errada, proprietário antigo em vez do atual — o mesmo princípio já aplicado à confirmação de permilagens linha a linha aplica-se ao envio em massa de convites. Automatizar o trabalho, não o erro.

**Impacto:** 04-PORTAS, 06-FATIAS (F3), diagrama de arquitetura.

---

## ADR-018 — TAM/SAM/SOM: 50.000 é Hipótese, Não Facto

**Estado:** ACEITE.

**Decisão:** o número de "50.000 condóminos-admin" passa a ser tratado como hipótese de mercado a validar, não como dado do TAM/SAM. TAM (universo teórico), SAM (mercado servido, hipotético) e SOM (adquirido via canais testados) ficam explicitamente separados no Business Plan.

**Justificação:** apresentar uma hipótese sem fonte/metodologia como se fosse um facto de mercado é o tipo de número que um investidor desmonta rapidamente, e mina a credibilidade do resto do plano.

**Impacto:** 07-BUSINESS-PLAN.

---

## ADR-019 — CAC Modelado Exclui Canais Institucionais Não Testados

**Estado:** ACEITE.

**Decisão:** o CAC *blended* usado nas projeções financeiras (08) deixa de incluir a premissa de conversão via parcerias institucionais (APEGAC/ANACON). Esses canais são testados como experiências de baixo compromisso, e só entram no CAC modelado depois de gerarem conversões reais mensuráveis.

**Justificação:** associações profissionais representam precisamente os administradores que o produto visa substituir — modelar financeiramente um canal com esse conflito de interesse estrutural, sem teste, é otimismo não fundamentado.

**Impacto:** 07-BUSINESS-PLAN, 08-PLANO-FINANCEIRO.

---

## ADR-020 — AuthorityRule Generaliza "Quem Pode Aprovar o Quê"

**Estado:** ACEITE.

**Decisão:** substitui o limiar único hardcoded ("Orçamento > limiar → assembleia adjudica") por `AuthorityRule` — tipo de decisão → limiar de valor → autoridade necessária (Admin/Assembleia), com base no regulamento do condomínio quando mais exigente que a lei.

**Justificação:** é o mesmo erro que já tínhamos corrigido no quórum (ADR-005) — uma regra fixa no código não serve todos os casos reais; diferentes tipos de decisão (renovar contrato pequeno vs. adjudicar obra grande) têm autoridade diferente.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-021 — Decision Brief como Padrão de Apresentação, Não Entidade Nova

**Estado:** ACEITE.

**Decisão:** recomendações de `Orcamento`/`Contract` são apresentadas ao admin num formato fixo de 5 perguntas (o que aconteceu / porque importa / o que encontrou / recomendação / o que precisa do admin) — gerado a partir dos dados existentes, não guardado como uma entidade `DecisionBrief` própria.

**Justificação:** o valor está no padrão de apresentação (decisão comprimida, "melhor valor" não "mais barato", sempre rastreável), não numa nova tabela. Criar uma entidade separada para isto seria complexidade sem benefício.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-022 — Contract é Versão Leve Agora (Lembrete, Não Motor de Procurement)

**Estado:** ACEITE — versão pesada fica Tier 3.

**Decisão:** `Contract` guarda dados de renovação (data, prazo de aviso prévio) e gera um lembrete automático antes do prazo. O sistema **não pesquisa mercado, não contacta fornecedores nem negocia sozinho** — essa automação fica documentada como visão futura, não construída agora.

**Justificação:** a proposta original de "LUMEN pesquisa alternativas, compara e recomenda 90 dias antes" é uma feature grande (pesquisa de mercado automatizada, negociação, comparação multi-critério) — desproporcional para 1 founder pré-seed com CAC ainda não validado. A versão leve entrega valor real (nunca perder um prazo de renovação) a uma fração do custo de construção.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-023 — 12 Entidades Propostas Reduzidas a 3 (Contract + AuthorityRule + Approval)

**Estado:** ACEITE — emendado por ADR-024.

**Decisão original:** da proposta de `Contract`/`Service`/`Inspection`/`Supplier`/`ProcurementRequest`/`Quote`/`QuoteComparison`/`DecisionBrief`/`Approval`/`Execution`/`ServiceEvent`/`ContractRenewal`, só `Contract` (versão leve) e `AuthorityRule` entravam como novidade real. `Service`/`Inspection` tornam-se valores do campo `Contract.tipo`. `ProcurementRequest`/`Quote`/`QuoteComparison` são cobertos por extensão de `Orcamento` já existente. `Supplier` já existe como `Fornecedor`. `DecisionBrief` é um padrão de apresentação (ADR-021), não entidade.

**Emenda (ver ADR-024):** `Approval` é promovido de Tier 3 para F4 — é barato (essencialmente um `AuditEvent` especializado) e fecha uma lacuna real de rastreabilidade legal. `Execution`/`ServiceEvent` continuam Tier 3.

**Justificação:** a maioria destas entidades resolve o mesmo problema que campos adicionais em `Orcamento`/`Fornecedor` já resolvem — criar tabelas novas para o mesmo dado é complexidade desnecessária, não rigor.

**Impacto:** 02-DOMINIO.

---

## ADR-024 — AuthorityRule é Centrada em Decisão, Não em Contract; Approval Fecha a Cadeia

**Estado:** ACEITE.

**Decisão:** `AuthorityRule` responde "quem pode autorizar esta ação concreta, neste contexto" (tipo de decisão: renovação, alteração de preço, rescisão, novo fornecedor, obra, seguro, inspeção, pagamento extraordinário) — nunca "quem pode aprovar contratos". `Contract` é um dos contextos que pode originar uma decisão, não o centro da autoridade. Promove-se `Approval` de Tier 3 (ADR-023) para F4: regista `decision_brief_snapshot`, `authority_rule_id`, quem aprovou, quando, resultado.

**Justificação:** centrar a autoridade em `Contract` limitaria o modelo a decisões contratuais; a autoridade tem de cobrir qualquer tipo de decisão operacional. Sem `Approval`, a cadeia de rastreabilidade (Decision Brief → dados → AuthorityRule → decisão) fica só implícita no `AuditEvent` genérico — um registo explícito é essencial para defesa legal se algo correr mal.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-025 — "Melhor Valor" Operacionalizado com Pesos e Confiança Qualitativa

**Estado:** ACEITE.

**Decisão:** `Orcamento.criterios_pesos` guarda os pesos usados na recomendação (ex: preço 30% / SLA 25% / garantia 15% / prazo 10% / histórico 10% / risco 10%), tornando "melhor valor" um cálculo com critérios explícitos, não uma expressão subjetiva. `confianca_recomendação` é sempre qualitativa (Alta/Média/Baixa) — **nunca um score numérico artificialmente preciso quando os dados são fracos** (nunca "87/100" quando falta informação de garantia; antes "Confiança Média — faltam dados sobre garantia").

**Justificação:** um score numérico falso é pior do que nenhum score — projeta uma certeza que os dados não sustentam, e destrói confiança na primeira vez que a recomendação falhar por essa razão.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-026 — Princípio de Criação de Entidades

**Estado:** ACEITE (princípio geral, aplicável a todo o domínio, não só Operações).

**Decisão:** uma entidade só se cria quando existe necessidade real de persistência, integridade ou comportamento que as entidades existentes não conseguem representar adequadamente — nunca "porque um sistema enterprise provavelmente teria uma". Consequência v6.1: **não** criar entidade `ConselhoFiscal` — usar Role `Fiscalizacao`.

**Justificação:** é a regra geral por trás da redução de 12 entidades propostas para 3 (ADR-023/024) — vale a pena declará-la explicitamente para se aplicar a decisões futuras, não só a esta.

**Impacto:** princípio transversal, referenciado em 02-DOMINIO.

---

## ADR-027 — Approval Versionado; Alteração Material Invalida Aprovação Anterior

**Estado:** ACEITE.

**Decisão:** `Approval` liga-se a uma `decision_brief_versao` específica, não "ao brief mais recente", e regista `scope` explícito (o que exatamente foi autorizado). Qualquer alteração material ao objeto de uma decisão depois de aprovada — preço, fornecedor, duração, âmbito do serviço, condições contratuais, risco, ou a autoridade necessária mudar — invalida a `Approval` anterior. Nunca se reaproveita silenciosamente uma aprovação para uma proposta diferente da que foi realmente aprovada. A aprovação antiga não é apagada (histórico auditável), fica marcada como referente à versão anterior, e é pedida uma nova aprovação sobre a versão nova. O mesmo padrão aplica-se ao conteúdo de uma Acta após `APPROVED` (ADR-034).

**Justificação:** sem isto, existe um cenário real e perigoso — "o administrador aprovou a opção B, mas a proposta mudou depois" — em que uma aprovação genérica ("sim") poderia ser reinterpretada para cobrir uma proposta diferente da que foi vista. Isto protege tanto o condomínio como o produto de disputas sobre "o que é que foi realmente aprovado".

**Impacto:** 02-DOMINIO (invariante 20, entidades `Orcamento`/`Approval`), 03-ORQUESTRA, 06-FATIAS (F4).

---

## ADR-028 — Pagamentos em Dinheiro: cash_status + verification_method

**Estado:** ACEITE.

**Decisão (v6.1 — reescrita):** `Payment.payment_method` inclui `cash`, com modelo próprio:

- `cash_status`: `registered` | `verified` | `deposited`
- `verification_method`: `second_person` | `bank_deposit` — **obrigatório ao entrar em `verified`**
- Evidência fotográfica do recibo físico: **obrigatória** em cash
- Em `second_person`: **registante ≠ verificador** (Membership/Person distintos)
- Sem pessoa com Role `Fiscalizacao` no tenant: **apenas** `bank_deposit` é permitido para verificação
- **Proibido:** Admin regista → o mesmo Admin confirma
- Uma `Obligation` **nunca** fica liquidada de forma definitiva só com `cash_status = registered`
- Prazo de depósito: configuração do tenant; **default = 5 dias úteis** após `registered`
- `cash_status` é **ortogonal** a `estado_alocação` (ADR-012)

**Justificação:** a modelação anterior tratava isto sobretudo como taxonomia (`payment_method: cash` + três labels). O problema real é controlo de fraude interna — um admin único a registar e confirmar dinheiro sozinho é, por desenho, um risco de auto-negociação, especialmente num condomínio de autogestão sem os controlos de uma administradora profissional segurada. Separar método de verificação e tornar o caminho `bank_deposit` o único disponível sem Fiscalizacao fecha o buraco sem obrigar todos os condomínios a nomear um fiscal.

**Impacto:** 02-DOMINIO, 06-FATIAS (F2).

---

## ADR-029 — Hash-Chain no Ledger (Especificação Técnica, Sem Overclaim)

**Estado:** ACEITE.

**Decisão (v6.1 — expandida):** cada `LedgerEntry` participa numa hash-chain por tenant. Especificação normativa (detalhe completo em 02-DOMINIO):

- **Campos no hash:** `entry_id`, `tenant_id`, `sequence`, `created_at`, `entry_type`, payload de negócio estável, `previous_hash`, `algorithm_version`
- **Serialização canónica:** UTF-8, JSON com chaves ordenadas, timestamps ISO-8601 UTC, versão da serialização amarrada a `algorithm_version`
- **`previous_hash` / `entry_hash`:** encadeamento sequencial; algoritmo inicial SHA-256 (`algorithm_version` ex.: `sha256-v1`)
- **Génese:** uma âncora por tenant (entrada génese ou sentinel versionado)
- **Ordenação:** `(tenant_id, sequence)` monotónico
- **Concorrência:** exclusão mútua por tenant na atribuição de `sequence` + `previous_hash`
- **Validação:** recalcular hashes e verificar ligação N↔N−1; mismatch = cadeia quebrada
- **Cadeia quebrada:** marcar integridade, alertar, restringir escritas, `AuditEvent` de rutura — **nunca** rewrite silencioso
- **Reparação:** apenas append-only (ajuste) + `AuditEvent` de break/repair; autoridade `PlatformAdmin`
- **Relação com AuditEvent:** complementar — audit = who/what/when; chain = ligação criptográfica entre entradas

**Limite explícito (não overclaim):** hash-chain = **deteção / evidência de adulteração**. **Não** é imutabilidade absoluta. **Não** é blockchain. **Não** protege contra um atacante que reescreve a BD inteira (dados + hashes). Blockchain público/distribuído continua rejeitado.

**Decisão Futura (fora do core):** checkpoint periódico / âncora externa.

**Justificação:** hash-chaining é barato e dá uma propriedade real de deteção que faltava. Promovido para F2 porque o custo de não o ter é desproporcional ao custo de o construir — desde que não se venda como "imutabilidade blockchain".

**Impacto:** 02-DOMINIO, 06-FATIAS (F2).

---

## ADR-030 — Retenção de Documentos Diferenciada por Tipo

**Estado:** ACEITE — corrige uma decisão anterior demasiado genérica. **Confirmado em v6.1.**

**Decisão:** retenção **diferenciada por categoria** — "guardar para sempre" **não** é política universal.

- **Instrumentos legais** (Regulamento Interno, Actas finais/publicadas): o documento original **é o instrumento legal em si**, não só "útil para auditoria" — retenção longa/indefinida.
- **Documentos financeiros gerados** (`FinancialDocument`): alinhados a obrigações legais/contabilísticas; reconstruíveis a partir do Ledger.
- **Documentos de identificação pessoal** (comprovativo IBAN, eventual ID): minimização RGPD — retenção limitada, com hash+metadados a persistir depois da purga do conteúdo.
- **Áudio:** ver ADR-011.

**Justificação:** a decisão anterior ("manter o original, política de retenção a definir") tratava todos os documentos com a mesma lógica. Isso está errado: para documentos legais a lógica é "nunca apagar o instrumento", para documentos pessoais é "minimizar". Aplicar a mesma política aos dois tipos seria, ou reter dados pessoais desnecessariamente, ou arriscar perder o instrumento legal do condomínio.

**Impacto:** 02-DOMINIO.

---

## ADR-031 — Role `Fiscalizacao` (Capacidade de Controlo desde F0)

**Estado:** ACEITE. **Confirmado em v6.1:** Role no conjunto inicial desde F0 (ver também emenda ADR-006).

**Decisão:** `Fiscalizacao` é um **Role** (capacidade de controlo), **não** uma entidade `ConselhoFiscal` nem um módulo de UI obrigatório. Quem o tem pode **confirmar** (não criar) ações sensíveis — nomeadamente verificação de pagamentos em dinheiro via `second_person` (ADR-028). **Não é obrigatório** atribuir este role a ninguém num tenant; é obrigatório que o modelo o permita **desde F0**, sem retrofitting. Sem Fiscalizacao atribuída, o único caminho de verificação de cash é `bank_deposit`.

**Justificação:** um admin sozinho + IA, sem nenhum humano de controlo possível no modelo, é um modelo de confiança mais fraco do que o que se está a tentar substituir. Isto é um risco de confiança do produto, não só técnico. Tratar Fiscalizacao como entidade/UI separada seria overbuild (ADR-026).

**Impacto:** 02-DOMINIO, 06-FATIAS (F0/F2).

---

## ADR-032 — Meta-Regra de Conflito Legal Explícita

**Estado:** ACEITE.

**Decisão:** lei (obrigatória, piso mínimo) > regulamento do condomínio (pode ser mais exigente, nunca pode contrariar a lei). Toda `ResolutionRule`/`AuthorityRule` que consulte "lei vs. regulamento" segue esta hierarquia sem exceção, declarada uma vez, não implícita em cada regra.

**Justificação:** esta hierarquia já estava implícita em várias partes da arquitetura, mas nunca declarada como princípio único — declará-la reduz o risco de uma implementação futura a decidir caso a caso de forma inconsistente.

**Impacto:** 03-ORQUESTRA, 02-DOMINIO.

---

## ADR-033 — Núcleo Financeiro/Governança Nunca Depende de LLM Disponível

**Estado:** ACEITE.

**Decisão:** ver saldo, votar, ver documentos, consultar o Ledger têm de funcionar mesmo se o provider LLM (Groq ou outro) estiver indisponível. A IA é uma camada de automação sobre o domínio, nunca uma dependência bloqueante do domínio em si.

**Justificação:** sem esta declaração explícita, é fácil introduzir sem querer uma chamada LLM no caminho crítico de uma rota financeira/de governança — o que tornaria uma funcionalidade nuclear do produto dependente da disponibilidade de um provider externo.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F0, requisito cross-cutting).

---

## ADR-034 — Acta: Assinatura/Subscrição + Máquina de Estados v6.1

**Estado:** ACEITE — corrige uma afirmação legal errada de uma ronda de análise anterior; **emendado em v6.1** com máquina de estados alargada e snapshots.

**Decisão legal (mantida):** a afirmação anterior ("tipicamente só a mesa da assembleia assina, não todos os presentes") estava **enganosa como descrição do regime jurídico português**. O art. 1.º do DL 268/94 (redação da Lei 8/2022) distingue explicitamente **assinatura** da ata (presidente) de **subscrição** (todos os condóminos presentes), e admite subscrição por assinatura manuscrita, assinatura eletrónica qualificada, ou declaração eletrónica anexa ao original. O n.º 3 confirma que a eficácia das deliberações depende da aprovação da ata, **independentemente de estar assinada**.

**Emenda v6.1 — máquina de estados:**

`DRAFT → SUBMITTED_FOR_APPROVAL → APPROVAL_IN_PROGRESS → APPROVED → PRINT_READY → SIGNATURES_PENDING → DOCUMENT_SUBMITTED → FINAL → PUBLISHED`

Regras adicionais:

- Aprovação ≠ voto de deliberação ≠ assinatura do presidente ≠ subscrição ≠ presença
- Regra de aprovação via `ResolutionRule` / lei / regulamento — **sem % universal inventada**; gate de advogado antes de produção
- `APPROVED` congela conteúdo; alteração material invalida aprovação
- Portal: durante aprovação vê-se o draft para a ação de aprovar; Acta final assinada **só em `PUBLISHED`**
- `PRINT_READY`: imprimir a versão exacta aprovada
- OCR/LLM só estrutural — nunca declara validade jurídica de assinatura manuscrita
- `hash_aprovada != hash_final` é esperado
- `Participante` e `Voto` = **snapshots históricos** (nome, qualidade, fração, permilagem no momento, proxy), não Membership live
- Hard-delete de áudio após `APPROVED` (ADR-011); política para fluxo stuck após APPROVED

**Justificação:** modelar "assinatura da mesa" como suficiente teria sido incorrecto. Separar `FINAL` de `PUBLISHED` evita expor no portal um documento ainda em validação. Snapshots evitam reescrita histórica quando Membership muda.

**Validar antes de produção:** modelo de subscrição eletrónica/declaração e interpretação de "subscrição" com advogado especializado em propriedade horizontal.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F5).

---

## ADR-035 — Experiência Móvel, Piloto vs. Lançamento Comercial, Email

**Estado:** ACEITE. **Emenda v6.1.**

**Decisão:**

- **PWA mobile-first** é suficiente para o lançamento — app nativa não é necessária
- Distinguir **piloto** de **lançamento comercial geral** (ver ADR-040, Opção A): o piloto tolera mais fricção; o lançamento comercial exige a experiência móvel completa definida em 04-PORTAS
- **Lista móvel sem votação até F5:** funcionalidades de consulta/lista no telemóvel podem existir antes; **votação** só entra com F5 (Assembleia). Não prometer voto móvel antes disso
- **Email / observabilidade:** o sistema garante *tentativa de envio + observabilidade* (estado de entrega do provider, logs, `AuditEvent` / delivery_status quando aplicável). **Não garante** que a mensagem chegue à inbox do destinatário (filtros spam, rejeição do ISP, mailbox cheia, etc.)
- Push notifications em PWA no iOS Safari: spike técnico de validação antes de assumir como resolvido

**Justificação:** para condóminos idosos/pouco tecnológicos, app nativa tipicamente aumenta fricção. Autonomia real depende da experiência móvel no lançamento comercial — não no primeiro piloto. Prometer "email entregue" sem controlo do último quilómetro cria expectativas falsas e disputas.

**Impacto:** 04-PORTAS, 06-FATIAS (F3, F5), ADR-040.

---

## ADR-036 — Legal Knowledge Base (Classificação e Política de Conflito)

**Estado:** ACEITE (modelo de dados / política; conteúdo legal versionado com gate de advogado).

**Decisão:** a Knowledge Base legal do LUMEN classifica cada norma/regra como:

| Classificação | Significado |
|---------------|-------------|
| `mandatory` | Obrigatória por lei — o produto não pode contrariar |
| `default` | Valor por omissão seguro, alterável dentro dos limites legais |
| `configurable` | Preferência do condomínio (ex.: dentro do que a lei permite) |
| `unknown` | Ainda não classificado / a confirmar com advogado — **não** usar como base de decisão automática |

Regras:

- Entradas **versionadas** (versão, effective_from, fonte, supersedes)
- Conflito: segue ADR-032 (lei > regulamento); entre versões, a vigente no momento do facto
- LLM **consultivo** apenas — nunca decide sozinho; Domain Rules + Risk Engine continuam determinísticos (ADR-008, ADR-033)
- Conteúdo marcado `unknown` ou sem validação legal recente: caminho de escalação humana, não AUTO

**Justificação:** sem classificação explícita, o produto mistura o que é lei, o que é default de UX e o que é opinião de LLM — exactamente o risco que a validação em camadas tenta evitar.

**Impacto:** 02-DOMINIO, 03-ORQUESTRA, 06-FATIAS (F6 / Policy Engine).

---

## ADR-037 — Saída do Tenant / Portabilidade de Dados

**Estado:** ACEITE (requisito arquitetural; implementação completa pode ser posterior).

**Decisão:** a arquitetura tem de permitir, sem redesign estrutural, a exportação pelo tenant (ou representante autorizado) de:

1. Dados financeiros (Obligation, Payment, Allocation, LedgerEntry + hashes, AccountingPeriod)
2. Documentos (FinancialDocument e documentos legais arquivados)
3. Actas (versões aprovadas/finais, snapshots, hashes)
4. Histórico operacional relevante
5. Auditoria relevante (`AuditEvent`)

Formato/SLA: decisão de implementação posterior. O desenho (1 BD/tenant, append-only, artefactos endereçáveis) **não** pode tornar a saída impossível ou opaca.

**Justificação:** condomínios mudam de ferramenta; um produto que "prende" o histórico financeiro e as Actas cria risco contratual e reputacional desproporcional. Declarar cedo evita que F2–F5 criem atalhos incompatíveis com exportação.

**Impacto:** 02-DOMINIO (invariante 28), 06-FATIAS (requisito cross-cutting), operações de plataforma.

---

## ADR-038 — Efeitos Assíncronos Críticos: Idempotentes e Observáveis (F0)

**Estado:** ACEITE — requisito de F0.

**Decisão:** side-effects críticos despoletados por Domain Events / Job Queue (notificações, escritas financeiras diferidas, eliminação de áudio, geração de documentos, sync bancário) têm de ser:

- **Idempotentes** — retry seguro com chave de deduplicação
- **Observáveis** — estado do job, falhas, contadores de retry; falha não silenciosa
- Visíveis para operações / PlatformAdmin quando falham de forma persistente

"Fire-and-forget" sem telemetria é insuficiente para o Domain Kernel de F0 (reforça ADR-009).

**Justificação:** sem isto, F1–F5 acumulam bugs de "correu uma vez a mais" ou "falhou e ninguém viu" — exactamente o tipo de falha que destrói confiança em dinheiro e Actas.

**Impacto:** 06-FATIAS (F0), 02-DOMINIO (invariante 29), diagrama de arquitetura.

---

## ADR-039 — Production Readiness Gates (Pointer)

**Estado:** ACEITE (ponteiro — checklist viva noutro artefacto / 06-FATIAS; não duplicar aqui a lista completa).

**Decisão:** antes de produção real com dinheiro, votos e decisões legais, o produto passa por **gates de readiness** explícitos, tipicamente incluindo (lista não exaustiva — detalhe operacional em 06-FATIAS / runbook):

- Propriedades testáveis de F0 (TenantDirectory, Audit, Jobs idempotentes, independência de LLM no núcleo)
- Validação legal: Acta (ADR-034), dinheiro (ADR-028), retenção/RGPD (ADR-011, ADR-030)
- Gate de advogado para `ResolutionRule` / Knowledge Base (ADR-036)
- Observabilidade de email/notificações sem overclaim de entrega (ADR-035)
- Distinção piloto vs. lançamento comercial (ADR-040)

Este ADR **não** substitui o checklist operacional — aponta para ele e impede "ir a produção porque a doc parece completa".

**Justificação:** documentação aceite ≠ produção segura. Um ponteiro no ADR-LOG torna o gate uma decisão de arquitetura, não uma preferência de release.

**Impacto:** 00-INDICE (veredicto GO/NO-GO), 06-FATIAS, operações.

---

## ADR-040 — Piloto vs. Lançamento Comercial Geral (Opção A)

**Estado:** ACEITE.

**Decisão (Opção A):** o **piloto** e o **lançamento comercial geral** são fases distintas com barras de qualidade diferentes:

| | Piloto | Lançamento comercial geral |
|---|--------|----------------------------|
| Âmbito | Poucos tenants, acompanhamento próximo | Mercado aberto |
| Fricção UX | Tolerada se o fluxo crítico funcionar | Experiência móvel completa obrigatória (ADR-035) |
| Votação móvel | Não antes de F5 | Só com F5 pronto e gates legais |
| Expectativa de suporte | Manual / founder | Processos e readiness (ADR-039) |
| Overclaim | Proibido em ambas | Proibido em ambas |

O piloto **não** autoriza a omitir invariantes de domínio (dinheiro, Ledger, Acta). Autoriza a diferir polish e canais não essenciais.

**Justificação:** misturar "já vendemos a toda a gente" com "ainda estamos a validar o piloto" cria pressão para saltar gates (ADR-039) e a prometer voto/email perfeitos cedo demais (ADR-035).

**Impacto:** 04-PORTAS, 06-FATIAS, 07-BUSINESS-PLAN, ADR-035, ADR-039.

---

## ADR-041 — Convocatória por meio por condómino (art. 1432.º)

**Estado:** ACEITE (arquitectura de produto). **Gates legais em aberto** — ver abaixo.

**Decisão:**

1. O meio de convocatória **não é uniforme** por tenant: regista-se **por `Membership`** (campos, não entidade nova — ADR-026):
   - `convocation_channel`: `registered_mail` | `authorized_email` | `other_admissible` | `unknown`
   - `convocation_email` quando o canal é `authorized_email`
   - `authorized_in_acta_id`, `authorized_at` — evidência da manifestação de vontade lavrada em acta (art. 1432.º n.º 2)
2. Evidência de envio: `ConvocationDispatch` (canal, destino, sent_at, delivery_state, receipt_at/receipt_ref, convocation_version, initiated_by, failures, resend_of) — pode ser outbox/auditoria tipada.
3. **`DeliberationNoticeDispatch` é separado** (art. 1432.º n.º 9) — convocatória ≠ comunicação das deliberações aos ausentes.
4. Canal `unknown`, em falta, ou email autorizado sem evidência/`convocation_email` → **HUMAN REVIEW**, **nunca AUTO SEND**.
5. Pipeline explícito: convocatória → realização → aprovação da Acta → assinatura/subscrição → comunicação aos ausentes.

**Justificação:** o art. 1432.º n.º 1 (carta registada / aviso com recibo) e n.ºs 2–3 (email só com vontade lavrada e recibo) tornam incorrecto um “enviar a todos por email” cego. Misturar convocatória com o n.º 9 corrompe auditoria e risco legal.

**Legal validation required (não fechado neste ADR):**

- Contagem exacta dos **10 dias** de antecedência (expedição vs. receção) — jurisprudência divergente; o produto **não** escolhe um lado.
- Validade prática do recibo de receção por email e consequências se o condómino não o enviar.
- Conteúdo concreto de `other_admissible`.

**Impacto:** 02-DOMINIO, 04-PORTAS, 06-FATIAS F5, PRODUCTION-GATES, diagramas.

---

## ADR-042 — Reunião contínua + RecordingSegment

**Estado:** ACEITE (arquitectura de produto). Retenção de áudio inalterada (ADR-011 / invariante 9); DPO confirma cobertura multi-segmento antes de produção.

**Decisão:**

1. Ciclo de vida da `Reuniao`: `DRAFT → IN_PROGRESS → ENDED`, depois processamento STT/Acta.
2. Sub-estados de gravação derivados dos segmentos: `recording` | `interrupted` | `idle_open`.
3. `RecordingSegment`: reuniao_id, ordinal, started_at, ended_at, reason_ended (`user_stop_segment` | `technical_interrupt` | `user_end_meeting`), storage_path, byte_size, status.
4. **Intenção humana ≠ falha técnica:** `technical_interrupt` **nunca** põe a reunião em `ENDED`; só `user_end_meeting` (ou acção humana equivalente) o faz.
5. Persistência progressiva (chunks / upload resumível); um ciclo MediaRecorder = segmento, **não** uma `Reuniao` nova.
6. **Uma Acta por Reuniao**; STT consome segmentos por ordinal.
7. Hard-delete após `Acta.APPROVED` cobre **todos** os segmentos da reunião (política v6.1 mantida).
8. Continuidade de gravação aplica-se a qualquer fluxo MediaRecorder (Assembleia F5 e Reuniões Admin F4).

**Justificação:** no código actual da Fonte, cada ciclo MediaRecorder + “Criar reunião” pode gerar um INSERT novo — isso parte a assembleia em várias “reuniões” e várias actas potenciais. O domínio LUMEN trata a reunião como sessão contínua com segmentos.

**Em aberto:** nomes exactos no schema da Fonte (`rascunho` / `processando_audio`, etc.) alinham-se na implementação sem inventar máquina paralela desnecessária; retenção multi-segmento a confirmar com DPO (mesmo critério pós-`APPROVED`).

**Impacto:** 02-DOMINIO, 06-FATIAS F4/F5, diagramas, implementação futura de recording.

---

## Itens Tier 3 — Documentados como Visão Futura, Não Backlog Atual

Não são ADRs (não há decisão de arquitetura a fixar agora), mas ficam registados para não se perderem nem serem reintroduzidos como scope creep prematuro:

- **Assembly → Project → Procurement → Contract:** execução automática de deliberações aprovadas. Forma do domínio permite-o (Deliberacao pode referenciar um Project futuro), motor não se constrói agora.
- **Autonomy Rate:** métrica de produto (% operações resolvidas sem intervenção humana). Os eventos que a alimentam (`DomainEvent`/`AuditEvent`) já existem desde F0; o dashboard não é prioridade de MVP.
- **Benchmarking entre tenants:** custo médio de elevador por região, fiabilidade de fornecedores, etc. Só faz sentido com volume real de tenants — é o moat de longo prazo, não uma feature de F0-F6.
- **Digital Twin como framing completo:** útil como diagrama conceptual (ver Diagrama 0 do ficheiro de arquitetura) para organizar o domínio e comunicar a visão — não implica construir mais estrutura do que a descrita em 02-DOMINIO.
- **Deteção proativa de necessidades operacionais:** LUMEN identificar sozinho ("contrato X% acima do mercado", "fornecedor excedeu SLA N vezes") sem o admin pedir. Exige monitorização de mercado e histórico automatizada.
- **Motor de procurement/renovação automatizado:** pesquisa de mercado, contacto automático a fornecedores, negociação dentro de limites, comparação multi-critério — hoje `Contract` só lembra o prazo de renovação (ADR-022).
- **Decision Compression:** métrica de quanto trabalho o LUMEN executou antes de apresentar uma decisão comprimida ao admin — junta-se à Autonomy Rate.
- **Centro de Operações com deteção proativa:** a versão leve (vista agrupada sobre dados existentes) entra em F4; a versão com deteção automática de anomalias fica para depois.
- **Checkpoint / âncora externa da hash-chain do Ledger:** Decisão Futura explícita em ADR-029 — fora do core.
