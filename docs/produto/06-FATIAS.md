# 06 — Fatias de Entrega (F0–F6)

> Cada fatia é entregável e testável independentemente.
> Nenhuma fatia posterior deve bloquear a anterior.

## Visão Geral

```
F0  Infra + Tenant          ████░░░░░░░░░░░░░░░░░░░░░░░░░░
F1  Ingestão + Constituição ░░░░████░░░░░░░░░░░░░░░░░░░░░░
F2  Financeiro              ░░░░░░░░████░░░░░░░░░░░░░░░░░░
F3  QR / Link Mágico + PWA ░░░░░░░░░░░░████░░░░░░░░░░░░░░
F4  Operações + Orçamentos  ░░░░░░░░░░░░░░░░████░░░░░░░░░░
F5  Assembleia              ░░░░░░░░░░░░░░░░░░░░████░░░░░░
F6  Orquestra LLM           ░░░░░░░░░░░░░░░░░░░░░░░░████░░
```

---

## F0 — Infra + Tenant

**Objectivo:** 1 BD por condomínio, auth multi-tenant, deploy base.

| Item | Detalhe |
|------|---------|
| Multi-tenant | 1 Turso DB por condomínio (Turso Platform API) |
| Auth | better-auth com tenant_id no session |
| Roles | super_admin (plataforma), admin (condomínio), condómino |
| API base | Hono com middleware tenant-aware |
| Deploy | Fly.io / Railway; BD em Turso |
| PWA shell | Layout creme + coral + terracota; responsive |

**Critério de conclusão:** admin cria tenant, recebe URL, faz login, vê dashboard vazio.

---

## F1 — Ingestão + Constituição

**Objectivo:** admin configura um condomínio completo a partir de PDFs e CSV.

| Item | Detalhe |
|------|---------|
| Upload Regulamento PDF | Armazenamento + extracção LLM de permilagens/regras |
| Frações automáticas | Criadas a partir das permilagens extraídas |
| Contactos proprietários | CSV upload ou manual |
| IBANs condomínio | Input admin |
| Orçamento anual | Definição por rubrica → quotas mensais calculadas |
| Confirmação | Admin revê e confirma dados extraídos |

**Critério:** admin sobe PDF, confirma permilagens, frações existem com quotas calculadas.

---

## F2 — Financeiro (transplante da dev)

**Objectivo:** gestão financeira completa — transplante + adaptação multi-tenant.

| Item | Transplante | Adaptação |
|------|-------------|-----------|
| Reconciliação banco | `reconciliation-engine.ts` | Parametrizar por tenant |
| CSV import | `csv-bank-parser.ts` | Multi-banco |
| Enable Banking | `routes/bank.ts` | ASPSP por tenant |
| Cascata amortização | `identity-matrix.ts` (lógica) | Extrair módulo |
| LLM fallback match | `llm-fallback.ts` | Como está |
| Recibos PDF | `routes/recibos.ts` | Template por tenant |
| Fecho de mês | `routes/relatorio.ts` | Como está |
| Morosos | dashboard + alertas | Como está |

**Critério:** banco sincroniza, transações reconciliam, recibos geram-se, fecho de mês funciona.

---

## F3 — QR / Link Mágico + PWA (PRIORIDADE)

**Objectivo:** qualquer condómino acede ao portal apontando o telemóvel.

| Item | Detalhe |
|------|---------|
| Token por fração | JWT/opaque, expirável, revogável |
| QR generator | Batch (PDF A4) + individual + email |
| Portal condómino | Saldo, recibos, tickets, votos, documentos |
| PWA | Service worker, offline shell, install prompt |
| Design | Creme + coral + terracota; tabs no fundo; mobile-first |
| Segurança | Exp 90d, rate limiting, confirmação para acções sensíveis |

**Critério:** admin gera QR, condómino scaneia, vê saldo e cria ticket com foto.

---

## F4 — Operações + Orçamentos

**Objectivo:** tickets com foto, fluxo de orçamentos com 3 cotações.

| Item | Detalhe |
|------|---------|
| Tickets | Criar com foto, categorização LLM, prioridade |
| Orçamentos | Área/tipo/descrição/urgência |
| Cotações | 3 fornecedores conhecidos + 2 mercado |
| SLA | 4h urgente, 48h normal |
| Parecer | LLM sugere ao admin |
| Adjudicação | Admin aprova (< limiar) ou assembleia vota |
| Fornecedores | Avaliação, histórico, categorias |

**Critério:** condómino cria ticket, admin recebe orçamentos, adjudica ou agenda votação.

---

## F5 — Assembleia

**Objectivo:** reuniões, transcrição áudio, atas automáticas, votação digital.

| Item | Transplante | Detalhe |
|------|-------------|---------|
| Áudio → texto | `stt.ts` (Whisper chunk 25MB) | Como está |
| Acta automática | `atas-llm.ts` + helpers | LLM gera a partir da transcrição |
| Votação digital | `routes/atas.ts` | Por fração, ponderada por permilagem |
| Convocatória | Novo | LLM gera, Jurídico revê |
| Deliberações | Novo | Extraídas da acta, vinculativas |
| Quórum | Novo | >50% permilagem 1ª conv, qualquer 2ª |

**Critério:** upload áudio, transcrição automática, acta gerada, condóminos votam via portal/QR.

---

## F6 — Orquestra LLM

**Objectivo:** Maestro + 5 especialistas + memória única.

| Item | Detalhe |
|------|---------|
| Maestro | Router que decide qual especialista activar |
| Memória Única | Knowledge base partilhada, 1 por tenant |
| Financeiro LLM | Especialista focado em finanças |
| Jurídico LLM | Porteiro do output e do dinheiro |
| Comunicação LLM | Única boca para o exterior |
| Operações LLM | Tickets, orçamentos, fornecedores |
| Assembleia LLM | Atas, votos, convocatórias |
| Custo tracking | Dashboard de tokens gastos por tenant |

**Critério:** input chega, maestro delega, especialista resolve, resultado validado pelo jurídico e enviado pela comunicação.

---

## Dependências entre fatias

```
F0 ──→ F1 ──→ F2 ──┐
                    ├──→ F3 (pode começar em paralelo com F2)
                    │
              F2 ──→ F4 ──→ F5 ──→ F6
```

- F3 (QR) pode ser desenvolvido em paralelo a partir do momento em que F1 (tenant + frações) existe
- F6 (Orquestra) é a última fatia — só faz sentido quando as outras existem
