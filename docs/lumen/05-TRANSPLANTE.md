# 05 — Transplante da `dev`

> **Versão: v6.1 | Data: 2026-09-10 | Estado: ACEITE (consistency hardening)**

> Stub mínimo. Inventário completo e prompts de implementação ficam para a fase de implementação / [09-ANALISE-CODEBASE-E-PROMPTS-CURSOR](09-ANALISE-CODEBASE-E-PROMPTS-CURSOR.md) (quando existir).

## Metáfora

A branch **`dev`** é a **dadora de órgãos**. O LUMEN multi-tenant **transplanta** só o que for domínio reutilizável — não o corpo inteiro do protótipo single-tenant.

## Fonte vs LUMEN

| | Fonte | LUMEN |
|---|-------|-------|
| Prova | Motor de reconciliação e fluxos associados **já validados em produção num condomínio** | Plataforma **multi-tenant em construção** |
| Código | Origem na `dev` / operação Fonte | Destino: Domain Services + isolamento por tenant |
| Frase de pitch | "motor de reconciliação já validado em produção num condomínio; a plataforma multi-tenant está em construção." | Usar as duas metades juntas — nunca só a primeira |

Não transplantar "o condomínio Fonte hardcoded" como se fosse o produto.

## Transplantar (órgãos)

- Reconciliação / cascata de matching (adaptar a `Obligation` / `Payment` / `Allocation` — ver 02)
- Banco + CSV (parsers, sync, fallbacks)
- Recibos / fecho de mês (gerar a partir do Ledger, não de flags soltas)
- Whisper com chunks ~25MB (+ overlap/diarização no destino F5)
- Tickets + foto
- LLM sugere + humano aprova (nunca LLM decide dinheiro/votos)
- Atas + voto (fluxo de estados e `ResolutionRule` no domínio LUMEN)

## Excluir (não transplantar)

- Hardcodes da Fonte / condomínio único
- `App_trade` (ou equivalente fora de âmbito)
- `condominio_buildingmind_v2` (ou árvore legada análoga)
- Premissas single-tenant (auth plana, uma BD global sem `TenantDirectory`, QR físico, etc.)

## Disciplina

Cada órgão transplantado passa por: isolamento de tenant → Domain Services → `AuditEvent` → testes.  
Inventário ficheiro a ficheiro: **adiado** à fase de implementação / doc 09.
