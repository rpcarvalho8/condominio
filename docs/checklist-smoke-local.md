# Checklist smoke — local (Condomínio 7663)

Validação após migração de dados (frações/âncoras na BD), limpeza RGPD e restart do ambiente.

## 0. Pré-requisitos

```bash
cd /home/rui/Documents/Condominio/App/Condominio-7663
bun install
# .env na raiz com DATABASE_URL, BETTER_AUTH_SECRET, WEBSITE_URL
# JSON locais (gitignored) se precisares de cartas/CSV matching:
#   identify-data.json, cartas-julho-data.json, bank-identity-map.json
```

Seeds úteis (só se BD vazia / clone novo):

```bash
cd packages/web
bun run seed:fracoes
bun run seed:gdpr-config
# opcional: bun --env-file=../../.env run src/api/database/seed-ancora.ts
# opcional: bun run seed:quotas-extras
bun --env-file=../../.env run scripts/create-admin.ts
```

## 1. Smoke BD (automatizado)

```bash
bun run smoke:db
```

Esperado: `Smoke OK` (frações > 0, users > 0, âncoras presentes).

## 2. Arranque

```bash
bun run dev
# → http://localhost:4200
```

Para Enable Banking (callback HTTPS): `ngrok http 4200` + alinhar `ENABLE_BANKING_REDIRECT_URI` / portal.

## 3. Auth

- [ ] Login admin (`admin@condominio.local` ou o teu email)
- [ ] Logout / login de novo

## 4. Dashboard

- [ ] Saldos CC / FR / Obras / Elevadores coerentes com âncoras
- [ ] Conta Corrente: tarja **amber** se houver pagamentos por categorizar
- [ ] Fração L não aparece como morosa CC se estiver coberta pelos pagamentos

## 5. Quotas / Morosos

- [ ] Quotas: badge **"Por categorizar"** vs Pago / Por pagar
- [ ] Marcar quota condomínio como paga → badge lateral de morosos desce **sem refresh**
- [ ] Desmarcar → badge sobe

## 6. Obras

- [ ] Botões Pagar nas linhas em atraso
- [ ] Totais "Por cobrar" coerentes

## 7. Banco (se sessão Enable Banking activa)

- [ ] Importar Dados → estado ligado
- [ ] Sincronizar agora sem `Wrong signature` / 401
- [ ] Sem `ERR_NGROK_3200` no callback (ngrok online)

## 8. Segurança (código tracked)

```bash
# Não deve listar IBANs/NIFs reais de condóminos no código versionado
git grep -nE 'PT50[0-9]{21}' -- '*.ts' '*.tsx' ':!_archive/**' || echo "OK: sem IBAN PT50 no código tracked"
```

- [ ] `identify-data.json` / `cartas-julho-data.json` / `bank-identity-map.json` **não** estão no `git status` como untracked a commitar (estão no `.gitignore`)
- [ ] Nenhum `*.pem` tracked (`git ls-files '*.pem'` vazio)

## 9. Resultado

Data: ________  
Smoke DB: OK / FAIL  
UI: OK / FAIL  
Banco: OK / FAIL / N/A  
Notas: ________
