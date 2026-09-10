# 01 — Constituição

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Stub mínimo. Detalhe de entidades, invariantes e fluxos: [02-DOMINIO](02-DOMINIO.md). Este documento não inventa direito — aponta a hierarquia e os dados fundacionais.

## Ideia central

A constituição do condomínio é dados: frações, permilagens, regulamento interno, IBANs, orçamento base, e a ligação entre pessoas e frações. O LUMEN trata isto como estado versionável e auditável, não como texto solto num PDF.

## Pessoas e acesso

`Person` é a pessoa no mundo. `Membership` liga Person ao tenant (e, quando aplicável, à fração) com um `Role` e, se necessário, um `Scope`.

Os roles de arranque incluem Admin, proprietário/co-proprietário, e `Fiscalizacao` (segunda pessoa de controlo — ver 02). O modelo é extensível; não é um enum fechado de três valores.

Autenticação identifica a pessoa. Autorização vem do `Membership` — nunca de um `user.role` plano, nem de QR físico.

## Hierarquia normativa (piso)

```
lei
  > regulamento
  > regulamento do condomínio
  > deliberações de Assembleia
  > políticas internas LUMEN
```

O regulamento do condomínio pode ser mais exigente que a lei; não pode contrariá-la. A interpretação assistida por LLM (Orquestra) é consultiva — ver [03-ORQUESTRA](03-ORQUESTRA.md) (Legal Knowledge Base).

## O que vive na constituição (visão)

Identidade do condomínio (morada, NIF, contas); frações e permilagens (Σ = 1000‰); regulamento interno (documento + regras extraídas com confirmação humana); orçamento anual como origem das `Obligation`s (detalhe em 02); contactos para onboarding, com confirmação humana antes de convites (ver 04).

## Fora de âmbito deste stub

Modelo completo de Ledger, Acta, `ResolutionRule`, dinheiro em numerário, hash-chain, etc. → [02-DOMINIO](02-DOMINIO.md).  
Gates legais e de privacidade antes de produção → [PRODUCTION-GATES](PRODUCTION-GATES.md).
