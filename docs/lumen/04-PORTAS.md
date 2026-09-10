# 04 — Portas (Ingestão + Onboarding por Convite)

**Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> **Decisão fechada (ADR-001):** QR Code físico (afixado, impresso ou reencaminhável como credencial) não existe no produto. Onboarding do condómino = Convite individual (`Invitation`): privado, uso único, revogável, com verificação de contacto antes de criar `Membership`.
>
> **Nota complementar (v6.1):** evidência de canal de comunicação alinha-se a convocatória / avisos (ADR-041) — ver Porta de Saída.
>
> Precedência: ADR-LOG > 02-DOMINIO > 06-FATIAS > diagramas > resto. Modelo de lançamento (piloto vs comercial): `06-FATIAS.md` e `00-INDICE.md`. Gates: [PRODUCTION-GATES.md](PRODUCTION-GATES.md).

---

## Diretiva de Design — Identidade Sevilla

Aplica-se a Portal Admin, Portal Condómino e PWA. Não reintroduzir paletas creme/coral/terracota.

| Elemento | Especificação |
|---|---|
| Estética geral | Minimalista, espaço em branco generoso, micro-interações suaves, tipografia limpa |
| Fundo dominante | Branco `#FFFFFF` e cinza muito claro `#F5F5F7` |
| Destaque primário | Vermelho Sevilha `#D0021B` / Vermelho-Escuro `#A80015` — CTA, alertas críticos, marca |
| Delimitação secundária | Prata/cinza neutro — estados secundários, contraste sem saturação |

---

## Piloto vs lançamento comercial

| | **Piloto (F0–F3 Essencial)** | **Comercial geral (F5 + gates)** |
|---|---|---|
| Recrutamento | Pessoal; tolera mais fricção UX | Escala; experiência móvel completa obrigatória |
| Votação | Não é critério | Disponível quando a governação (F5) estiver live |
| Actas | Consulta só se existirem `PUBLISHED` | Fluxo completo de Acta + votação |
| Distribuição | Sem escala além do piloto enquanto F0–F2 instáveis | Após [PRODUCTION-GATES](PRODUCTION-GATES.md) |
| Dinheiro / legal em produção | NO-GO até aos gates | Só com gates cumpridos |

Capacidades Essencial: `06-FATIAS.md` (Opção A).

---

## Experiência móvel

**Decisão:** PWA mobile-first basta para lançar. App nativa costuma aumentar a fricção para condóminos pouco tecnológicos (loja + instalação) face a um link de convite por email/SMS.

### Obrigatório no telemóvel — lançamento comercial (sem votação até F5)

Lista mínima sem exigir votação enquanto a governação não estiver live:

- Ver saldo / dívidas (sempre do Ledger, nunca de cache)
- Ver e descarregar Avisos de Débito / Recibos / Extrato
- Criar ticket com foto
- Ver atas publicadas e documentos
- Aceitar convite e criar conta
- Contactar o admin

Quando a governação (F5) estiver live, votar com step-up de autenticação entra na lista móvel obrigatória do comercial geral. No piloto vale a mesma base Essencial, com mais fricção tolerada e sem votação como critério.

Pode ficar para depois: Reuniões Admin (admin-only), Centro de Operações completo, app nativa, escrita offline completa, biometria avançada, KYC verdadeiro.

### Spike PWA / iOS push (antes de fechar F3)

Push em PWA no iOS Safari (16.4+) exige “Adicionar ao ecrã principal”. Validar com spike técnico dedicado antes de fechar F3. Se não for fiável, email continua o canal primário; push fica best-effort.

### Email e notificações (desde F0)

Email é o canal primário: envio, retry, estado de entrega e observabilidade (correlação + `AuditEvent` / `DomainEvent`). Não se afirma “entrega garantida na caixa de entrada” — spam, ISP e dispositivo estão fora do nosso controlo. Push é best-effort e nunca a única via para aviso crítico.

---

## Visão Geral

```
┌──────────────────────────────────────────────────────┐
│                    PORTAS DE ENTRADA                  │
│                                                       │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────┐│
│  │ Ingestão │   │ Convite      │   │ Portal Web    ││
│  │ Admin    │   │ Individual   │   │ (autenticado) ││
│  └────┬─────┘   └──────┬───────┘   └───────┬───────┘│
│       │                 │                    │        │
│       ▼                 ▼                    ▼        │
│  ┌────────────────────────────────────────────────┐  │
│  │              TENANT (1 BD)                      │  │
│  │     Membership concede acesso — nunca um QR      │  │
│  └────────────────────────────────────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────────┐│
│  │              PORTA DE SAÍDA                        ││
│  │  Comunicação (única boca) → Validação em camadas  ││
│  │  email | chat | notif | acta | contrato           ││
│  └──────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────┘
```

---

## Porta 1: Ingestão Admin (Onboarding do Tenant)

```
1. Registo admin
   └─ email, password, nome → Person + Membership (role: Admin)
2. Dados do condomínio
   └─ morada, NIF, IBAN(s)
3. Upload Regulamento Interno (PDF ou foto)
   └─ LLM Jurídico extrai permilagens, regras, penalizações, limiar de obras
4. Admin confirma/corrige permilagens — linha a linha
   └─ excerto do PDF de origem visível; Σ permilagens = 1000‰
5. Upload contactos proprietários
   └─ PDF/Excel/foto ou manual
   └─ tabela de pré-visualização (fração ↔ pessoa ↔ contacto)
      antes de qualquer convite — nunca envio automático a partir do OCR
6. Upload comprovativo IBAN do condomínio
   └─ PDF ou foto — ver retenção diferenciada abaixo
7. Dados bancários
   └─ IBAN(s); opção Enable Banking (PSD2) → BankConnection na conta
      do condomínio (não na pessoa do admin)
8. Orçamento anual por rubrica
   └─ Quota corrente, FCR (DL 268/94 art. 4.º), Extraordinária
      → Obligations a partir de deliberação/orçamento aprovado
```

Resultado: tenant pronto, frações com Obligations, admin com Membership, banco ligado (se aplicável).

### Comprovativo IBAN e retenção (ADR-030)

| Tipo | Exemplos | Política |
|---|---|---|
| **Instrumento legal** | Regulamento Interno, Actas | Retenção indefinida — o original *é* o instrumento |
| **Documento pessoal / identificação** | Comprovativo IBAN (e eventual ID futuro) | Minimização RGPD: retenção limitada; após purga do conteúdo, persistem hash + metadados para auditoria |

O upload do comprovativo IBAN não segue a mesma política de retenção que o Regulamento ou a Acta.

### Lead magnet — relatório de reconciliação

Oferta de aquisição (não CRM interno). Linguagem: divergências auditáveis — nunca “está a pagar a mais” / fraude definitiva sem prova determinística do Ledger.

| Modo | Quando | Limite |
|---|---|---|
| **A — Self-serve CSV** | Quando F1/F2 existirem | Utilizador carrega extrato; relatório gerado pelo motor de reconciliação |
| **B — Assistido (piloto)** | Durante o piloto | Capado a máx. 4 por mês no piloto |

---

## Porta 2: Onboarding do Condómino — Convite Individual

> Sem QR físico em zona comum, fração, hall, ou reencaminhável por foto/email como credencial.

### Conceito

O admin cria um `Invitation` para uma fração e um contacto já registado (email/SMS). O convite é privado, de uso único, revogável e expira em poucos dias — sem impressão, afixação ou reutilização.

### Ativação da comunidade (lote com confirmação)

```
Contactos importados (OCR/LLM)
         │
         ▼
Tabela de pré-visualização
(fração ↔ pessoa ↔ contacto)
         │
         ▼
Admin confirma correspondências
(corrige OCR, fração errada, contacto em falta)
         │
         ▼
Botão explícito: "Enviar N Convites"
         │
         ▼
Convites em lote (mesmo lote_id) + envio
         │
         ▼
Painel de ativação
(convidados · contas · portal · documentos)
```

**Nunca** dispara convites só porque o OCR processou uma foto.

### Fluxo por convite

```
Admin cria Convite para Fração X
         │
         ▼
Sistema envia link único por email/SMS
         │
         ▼
Destinatário abre o link
         │
         ▼
Verificação de contacto
(confirma email/SMS — prova posse do contacto;
 NÃO é KYC / verificação de identidade legal)
         │
         ▼
Cria conta nova OU associa conta existente
         │
         ▼
Admin (ou fluxo já validado) garante
Person ↔ Fraction ↔ Membership
         │
         ▼
Membership criado
(Person + Fracao + Role: Owner/CoOwner/Proxy)
         │
         ▼
Sessão autenticada (better-auth)
         │
         ▼
  ┌──────────────────────────────┐
  │   Portal do Condómino        │
  │                              │
  │  • Saldo / dívidas (Ledger)  │
  │  • Avisos / Recibos / Extrato│
  │  • Criar ticket + foto       │
  │  • Documentos / Actas PUBLISHED │
  │  • Contactar admin           │
  │  • Votar — só com F5 live    │
  └──────────────────────────────┘
```

### Verificação de contacto vs. identidade

| Conceito | No MVP / piloto | Notas |
|---|---|---|
| **Verificação de contacto** | Sim | Código/link no email/SMS; prova que o destinatário controla o contacto |
| **Validação Person ↔ Fraction ↔ Membership** | Sim (admin) | Correspondência operacional revista na pré-visualização e no Membership |
| **KYC / verificação de identidade legal** | Não | **Future Decision** — fora do MVP |

Usar sempre a expressão verificação de contacto, não “verificação de identidade”, neste documento e na UX.

### Step-up

Alterar IBAN, alterar titular, ações financeiras sensíveis — e votar quando F5 existir — exigem confirmação adicional (ex.: código ao contacto verificado), não só a sessão base.

### QR residual (único permitido)

O link de um Convite já emitido e enviado digitalmente pode aparecer como QR dentro do próprio email/SMS — nunca impresso, nunca afixado, nunca reutilizável. Caso típico: novo proprietário após venda de fração.

### Design / PWA

PWA; tabs no fundo; mobile-first. Fundo branco/cinza Sevilla; CTA vermelho Sevilha. Spike iOS push antes de fechar F3 (ver acima).

### Segurança

Uso único; revogável; rate limiting por IP + token. Reemissão: venda de fração → revogar Membership antigo → novo Convite (nunca QR reaproveitado).

### Kit de assembleia (fricção de venda)

Ordem do dia / briefing leve para o piloto — reduz fricção comercial. Não é CRM nem pipeline de leads interno (o lead magnet de reconciliação é oferta externa; ver acima).

---

## Porta 3: Portal Web (condómino autenticado)

Login email + password (better-auth); sessão ligada ao `Membership`. Mesmo conteúdo Essencial do onboarding, com sessão persistente. Extra: alterar dados pessoais (step-up se sensível), histórico completo. Votação só quando F5 estiver live.

---

## Porta de Saída: Comunicação + Validação em Camadas

### Comunicação (única boca)

Todo email, chat, notificação, acta, contrato e o link de Convite passam por este módulo. Nenhum outro módulo envia mensagens directamente. Templates para tom e marca consistentes. Observabilidade de envio/retry/estado — sem promessa de inbox garantida.

**Evidência de canal (governação):** convocatórias e avisos legais registam canal, destino, estado de entrega e recibo quando aplicável (`ConvocationDispatch` / `DeliberationNoticeDispatch` — ver 02-DOMINIO). Convocatória ≠ comunicação das deliberações aos ausentes (art. 1432.º n.º 9). Canal `unknown` ou autorização em falta → HUMAN REVIEW, nunca AUTO SEND (ADR-041).

### Validação em Camadas

Schema + Domain Rules + Legal Interpretation (LLM Jurídico, consultivo) → Risk Engine → AUTO / Aprovação admin / Escalação humana-legal. Ver `03-ORQUESTRA.md`.
