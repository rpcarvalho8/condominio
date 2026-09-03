# 04 — Portas (Ingestão + QR/Link Mágico)

## Visão Geral

```
┌──────────────────────────────────────────────────┐
│                  PORTAS DE ENTRADA                │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Ingestão │  │ QR/Link  │  │ Portal Web    │  │
│  │ Admin    │  │ Mágico   │  │ (condómino)   │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │               │            │
│       ▼              ▼               ▼            │
│  ┌────────────────────────────────────────────┐  │
│  │            TENANT (1 BD)                   │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  ┌──────────────────────────────────────────────┐│
│  │              PORTA DE SAÍDA                  ││
│  │  Comunicação (única boca) → Jurídico (rev.)  ││
│  │  email | chat | notif | acta | contrato      ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

## Porta 1: Ingestão Admin (Onboarding do Tenant)

Sequência de setup de um novo condomínio:

```
1. Registo admin
   └─ email, password, nome
2. Dados do condomínio
   └─ morada, NIF, IBAN(s)
3. Upload Regulamento Interno (PDF)
   └─ LLM Jurídico extrai:
      ├─ permilagens por fração
      ├─ regras de utilização
      ├─ penalizações
      └─ limiar obras sem assembleia
4. Admin confirma/corrige permilagens
   └─ frações criadas automaticamente
5. Upload contactos proprietários
   └─ CSV ou manual: nome, email, telefone, NIF, fração
6. Dados bancários
   └─ IBAN(s) do condomínio
   └─ Opção: ligar Enable Banking (PSD2)
7. Orçamento anual
   └─ define quotas mensais por rubrica
```

**Resultado:** tenant pronto, frações com permilagens, proprietários com contactos, banco ligado.

## Porta 2: QR / Link Mágico (PRIORIDADE — Módulo 3)

> Este módulo é prioritário: permite que qualquer condómino aceda ao portal sem instalar app.

### Conceito

- Cada fração tem um **QR code único** (colado no hall, enviado por email, impresso na carta)
- QR aponta para URL: `https://app.buildingmind.pt/p/{token}`
- Token = JWT ou opaque token com `{tenant_id, fracao_id, exp}`
- Sem password, sem registo — acesso imediato ao portal da sua fração

### Fluxo

```
Condómino aponta câmara → QR
         │
         ▼
  https://app.buildingmind.pt/p/{token}
         │
         ▼
  ┌──────────────────────────┐
  │   Portal do Condómino    │
  │                          │
  │  • Saldo / dívidas       │
  │  • Recibos (download)    │
  │  • Criar ticket + foto   │
  │  • Votar (assembleia)    │
  │  • Documentos (atas)     │
  │  • Contactar admin       │
  └──────────────────────────┘
```

### Design

- **PWA** — funciona como app sem instalar
- **Layout:** fundo creme, accent coral, terracota no botão QR/destaque
- **Mobile-first** — a maioria vai usar telemóvel
- **Sem sidebar** — navegação por tabs no fundo (estilo app nativa)

### Segurança

- Token expira (ex: 90 dias) — admin regenera
- Revogável por fração (mudança de proprietário)
- Acções sensíveis (votar, pagar) pedem confirmação extra (PIN ou SMS)
- Rate limiting por IP + token

### Geração dos QR

- Admin gera em batch (todas as frações) ou individual
- Output: PDF A4 com QR + nome fração + instrução — pronto para imprimir e colar
- Email automático com QR para cada proprietário

## Porta 3: Portal Web (condómino autenticado)

- Login com email + password (better-auth)
- Mesmo conteúdo do QR mas com sessão persistente
- Funcionalidades extra: alterar dados pessoais, histórico completo

## Porta de Saída: Comunicação + Jurídico

### Comunicação (única boca para o exterior)
- Todo email, chat, notificação, acta, contrato passa por este módulo
- Nenhum outro módulo envia mensagens directamente
- Template engine para consistência de tom e marca

### Jurídico (porteiro do que SAI)
- Revê comunicações com relevância legal
- Valida despesas acima de limiar
- Verifica conformidade com regulamento interno
- **Não é porteiro de cada ecrã** — é porteiro do output e do dinheiro
