# 05 — Transplante da `dev`

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Stub mínimo. Inventário completo e prompts de implementação ficam para a fase de implementação / [09-ANALISE-CODEBASE-E-PROMPTS-CURSOR](09-ANALISE-CODEBASE-E-PROMPTS-CURSOR.md) (quando existir).

## Metáfora

A branch `dev` é a dadora de órgãos. O LUMEN multi-tenant transplanta só o que for domínio reutilizável — não o corpo inteiro do protótipo single-tenant.

## Fonte vs LUMEN

| | Fonte | LUMEN |
|---|-------|-------|
| Prova | Motor de reconciliação e fluxos associados já validados em produção num condomínio | Plataforma multi-tenant em construção |
| Código | Origem na `dev` / operação Fonte | Destino: Domain Services + isolamento por tenant |
| Frase de pitch | "motor de reconciliação já validado em produção num condomínio; a plataforma multi-tenant está em construção." | Usar as duas metades juntas — nunca só a primeira |

Não transplantar "o condomínio Fonte hardcoded" como se fosse o produto. A prova Fonte não significa que o LUMEN multi-tenant esteja em produção.

## Transplantar (órgãos)

Reconciliação / cascata de matching (adaptar a `Obligation` / `Payment` / `Allocation` — ver 02); parsers e sync bancário + CSV; recibos e fecho de mês gerados a partir do Ledger (não de flags soltas); Whisper com chunks ~25MB (overlap/diarização no destino F5); tickets com foto; LLM sugere e humano aprova (nunca LLM decide dinheiro ou votos); atas e voto com fluxo de estados e `ResolutionRule` no domínio LUMEN.

## Excluir (não transplantar)

Hardcodes da Fonte / condomínio único; `App_trade` (ou equivalente fora de âmbito); `condominio_buildingmind_v2` (ou árvore legada análoga); premissas single-tenant (auth plana, uma BD global sem `TenantDirectory`, QR físico como credencial, etc.).

## Disciplina

Cada órgão transplantado passa por isolamento de tenant → Domain Services → `AuditEvent` → testes. Inventário ficheiro a ficheiro: adiado à fase de implementação / doc 09.
