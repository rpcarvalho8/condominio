# Limpeza RGPD — dados pessoais no código

Actualizado: 2026-08-11 (branch `dev`)

## Objectivo
Remover nomes, IBANs, NIFs, moradas e valores individuais de dívida do código versionado.
Dados sensíveis vivem só na BD + ficheiros locais ignorados pelo Git.

## Backups locais (gitignored)
| Ficheiro | Conteúdo |
|----------|----------|
| `identify-data.json` | 33 frações + pagamentos não categorizados + listas slim de devedores |
| `cartas-julho-data.json` | Cartas de cobrança julho 2026 |
| `bank-identity-map.json` | `FRACOES_INFO` + `NAME_FRACAO_MAP` (matching bancário) |

## Seed
```bash
cd packages/web
bun run seed:fracoes      # identify-data.json → fracoes
bun run seed:gdpr-config  # identify-data + cartas → configuracoes
bun run seed:ancora       # se aplicável
```

## Estado por ficheiro

### Limpo (PII removido do código)
- [x] `identity-matrix.ts` — cache vazia + `loadMatrizFromDB()`
- [x] `dashboard.ts` — Excel/PAGAMENTOS → `configuracoes` / `fracoes`
- [x] `cartas-julho-2026.ts` — loader ficheiro/BD
- [x] `avisos.ts` — listas Excel → `configuracoes` (NIF/IBAN da **entidade** condomínio mantidos para PDF)
- [x] `csv-bank-parser.ts` — mapa nomes → `bank-identity-map.json`
- [x] `seed.ts` — nomes fictícios
- [x] `cativo-rules.ts` — exemplo anonimizado
- [x] `test-desempate-af.ts`, `test-sync-simulation.ts`, `inject-qa-v2-turso.ts`
- [x] `setup-local-db.ts` / `seed-dividas.ts` — nomes anonimizados

### OK / sem PII pessoal hardcoded
- [x] `llm-fallback.ts`, `bank.ts`, `identity.ts` — runtime / sem roster
- [x] `schema.ts` — só estrutura

### Pendente / aceite consciente
- [ ] `recibos.ts` / `relatorio.ts` / `avisos.ts` — NIF + IBAN + morada da **entidade** condomínio (cabeçalho legal PDF). Preferível: env/`configuracoes` (`condominio_nif`, `condominio_iban`).
- [ ] Confirmar que `node_modules` continua ignorado (não limpar).
- [ ] Após clone novo: restaurar os 3 JSON locais + correr seeds antes de usar matching bancário / dashboard cartas.

## Riscos
1. Sem `seed:gdpr-config`, `pagamentosNaoRegistados` e morosos portão/indaqua ficam vazios.
2. Sem `cartas-julho-data.json` / seed cartas, rubricas baseadas em cartas caem para BD.
3. Sem `bank-identity-map.json`, matching por nome no CSV bancário fica desactivado.
4. Re-correr `seed:fracoes` pode sobrescrever dívidas corrigidas na BD (ex. L obras 2118.97 vs 2110.97 no JSON).
