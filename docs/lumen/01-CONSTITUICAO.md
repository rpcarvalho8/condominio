# 01 — Constituição

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Stub mínimo. Detalhe de entidades, invariantes e fluxos: [02-DOMINIO](02-DOMINIO.md). Este documento **não inventa direito** — aponta hierarquia e dados fundacionais.

## Ideia central

A **constituição do condomínio é dados**: frações, permilagens, regulamento interno, IBANs, orçamento base, e a ligação entre pessoas e frações. O LUMEN trata isto como estado versionável e auditável, não como texto solto num PDF.

## Pessoas e acesso

- **`Person`** — a pessoa no mundo
- **`Membership`** — a ligação Person ↔ tenant/fração com `Role` (+ `Scope` quando necessário)
- Roles de arranque incluem Admin, proprietário/co-proprietário, e `Fiscalizacao` (segunda pessoa de controlo — ver 02); o modelo é extensível, não um enum fechado de três valores

Autenticação identifica a pessoa; **autorização** vem do `Membership`, nunca de um `user.role` plano nem de QR físico.

## Hierarquia normativa (piso)

```
lei
  > regulamento
  > regulamento do condomínio
  > deliberações de Assembleia
  > políticas internas LUMEN
```

O regulamento do condomínio pode ser mais exigente que a lei; **não** pode contrariá-la. Interpretação assistida por LLM (Orquestra) é **consultiva** — ver [03-ORQUESTRA](03-ORQUESTRA.md) (Legal Knowledge Base).

## O que vive na constituição (visão)

- Identidade do condomínio (morada, NIF, contas)
- Frações e permilagens (Σ = 1000‰)
- Regulamento interno (documento + regras extraídas com confirmação humana)
- Orçamento anual → origem das `Obligation`s (detalhe em 02)
- Contactos para onboarding (confirmação humana antes de convites — ver 04)

## Fora de âmbito deste stub

Modelo completo de Ledger, Acta, `ResolutionRule`, dinheiro em numerário, hash-chain, etc. → **[02-DOMINIO](02-DOMINIO.md)**.  
Gates legais/privacidade antes de produção → **[PRODUCTION-GATES](PRODUCTION-GATES.md)**.
