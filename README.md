# Gestão de Condomínio

Aplicação web para gestão de condomínios, com sincronização bancária automática (Enable Banking → Santander Empresas), reconciliação de quotas/despesas, recibos, relatórios e portal do condómino.

> Este README foi reescrito em 2026-07-18 após uma sessão de debugging profunda da integração bancária. Reflete o estado real e testado da aplicação, não apenas o planeado.

---

## 1. Stack

- **Runtime**: Bun
- **Backend**: Hono (`.basePath("api")`) — código em `packages/web/src/api/`
- **Frontend**: React 19 + Vite 7 + Tailwind CSS + Wouter — código em `packages/web/src/web/`
- **Base de dados**: Turso (LibSQL/SQLite) via Drizzle ORM. Em dev local pode usar-se um ficheiro SQLite simples (`file:./local.db`).
- **Auth**: better-auth (sessão via cookie, não JWT Bearer manual)
- **Mobile**: Expo (`packages/mobile`)
- **Desktop**: Electron (`packages/desktop`)
- **Integração bancária**: [Enable Banking](https://enablebanking.com) (Open Banking / PSD2 aggregator) — acesso ao Santander Totta (Santander Empresas PT)

Monorepo Bun workspaces. Um único servidor Vite (`packages/web`) serve API (`/api/*`) e frontend (`/*`) na mesma porta.

---

## 2. Módulos implementados

| Módulo | Estado |
|--------|--------|
| Autenticação (better-auth, roles admin/condómino) | ✅ |
| Frações & Proprietários | ✅ |
| Quotas mensais + extras (elevadores, portão/motor, incêndio, obras) | ✅ |
| Recibos PDF (geração + envio automático mensal) | ✅ |
| Despesas | ✅ |
| Fornecedores | ✅ |
| Morosos (controlo de dívidas) | ✅ |
| Relatórios financeiros (mensal, automático) | ✅ |
| Portal do condómino | ✅ |
| **Sincronização bancária — Enable Banking (Santander Empresas)** | ✅ **Ligado e a funcionar** (ver secção 4) |
| Importação manual de CSV (extratos Santander) | ✅ |
| Motor de reconciliação / Matriz de Identidade (auto-match fração ↔ movimento) | ✅ |
| Camada 2 — fallback LLM (Groq/OpenRouter) para transações não identificadas pela matriz | ✅ |
| Agente de monitorização de pasta (importação automática de CSV) | ✅ |

---

## 3. Variáveis de ambiente (`.env` na raiz do projeto)

```env
NODE_ENV=development
WEBSITE_URL=http://localhost:4200

# Auth
BETTER_AUTH_SECRET=...

# Base de dados (Turso ou ficheiro local)
DATABASE_URL=libsql://... | file:./local.db
DATABASE_AUTH_TOKEN=...          # só necessário para Turso remoto

# Gateway/Pagamentos (opcional)
AI_GATEWAY_BASE_URL=
AI_GATEWAY_API_KEY=
AUTUMN_SECRET_KEY=

# LLM Fallback — Camada 2 de identificação de transações (opcional)
GROQ_API_KEY=
OPENROUTER_API_KEY=

# ── Enable Banking ──────────────────────────────────────────────
ENABLE_BANKING_CLIENT_ID="<application_id gerado no portal Enable Banking>"
ENABLE_BANKING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ENABLE_BANKING_ASPSP_NAME=Santander Totta
ENABLE_BANKING_ASPSP_COUNTRY=PT
ENABLE_BANKING_REDIRECT_URI="https://<teu-dominio-ou-tunnel>/api/bank/callback"
```

### ⚠️ Detalhes críticos que já nos custaram horas de debug

1. **`ENABLE_BANKING_ASPSP_NAME` tem de ser exatamente `Santander Totta`** (sem `(PT)`, sem mais nada). Confirmado com uma chamada real e autenticada a `GET https://api.enablebanking.com/aspsps?country=PT` — é o único valor aceite para o Santander Empresas em produção. Qualquer outro valor dá `422 WRONG_ASPSP_PROVIDED`.

2. **`ENABLE_BANKING_PRIVATE_KEY` tem de ser PKCS8 sem cifra**, com o header `-----BEGIN PRIVATE KEY-----` (não `-----BEGIN RSA PRIVATE KEY-----`, que é PKCS1 e vai dar mismatch se o conteúdo for na verdade PKCS8). Se o ficheiro exportado do portal tiver passphrase, ou o header não bater certo com o encoding real, a assinatura do JWT falha com:
   ```
   error:1E08010C:DECODER routines::unsupported
   ```
   Verifica sempre a chave antes de a usar:
   ```bash
   node -e "
     const crypto = require('crypto');
     const pem = require('fs').readFileSync('.env','utf8').match(/ENABLE_BANKING_PRIVATE_KEY=\"(.+)\"/s)[1].replace(/\\\\n/g,'\n');
     const k = crypto.createPrivateKey(pem);
     console.log('✅', k.asymmetricKeyType, k.asymmetricKeyDetails.modulusLength, 'bits');
   "
   ```

3. **`ENABLE_BANKING_REDIRECT_URI` tem de ser HTTPS** — a Enable Banking rejeita `http://` mesmo para testes locais (`unsupported scheme`). E tem de ser **exatamente igual, byte a byte** (protocolo + domínio + path `/api/bank/callback`) a uma entrada na lista **"Allowed redirect URLs"** da aplicação no portal Enable Banking.
   - Para testar em `localhost`, usa um túnel HTTPS: `ngrok http 4200` (ou `cloudflared tunnel --url http://localhost:4200`) e regista o URL gerado (`https://xxxx.ngrok-free.dev/api/bank/callback`) no portal.
   - **No plano free do ngrok o subdomínio muda a cada reinício** — é preciso repetir o registo no portal sempre que reinicias o túnel.

4. Nunca commitar o `.pem`/private key no git. Já aconteceu neste projeto (ver secção 6, "Incidentes resolvidos") — se voltar a acontecer, revoga o certificado no portal imediatamente.

---

## 4. Como testar a integração bancária localmente

```bash
# 1. Instalar dependências
bun install

# 2. Preencher o .env (ver secção 3)

# 3. Expor a app publicamente via HTTPS (obrigatório p/ Enable Banking)
ngrok http 4200
# copia o URL https://xxxx.ngrok-free.dev gerado

# 4. Regista <URL>/api/bank/callback no portal Enable Banking
#    (App → Redirect URLs → adicionar)

# 5. Atualiza ENABLE_BANKING_REDIRECT_URI no .env com o mesmo URL

# 6. Arranca o servidor
bun run dev
# ➜ http://localhost:4200

# 7. Acede via o URL do ngrok (não localhost diretamente, para o cookie/sessão
#    de callback funcionar corretamente com o domínio público)
#    Login → Importar Dados → Conectar Banco → login real no Santander Empresas
```

Depois de ligado, a página **Importar Dados** mostra:
- Estado da ligação (`Santander Totta — Ligado`)
- Botão **Sincronizar agora** (chama `POST /api/bank/sync`, incremental desde o último sync)
- Histórico de importações CSV
- Configuração do agente de pasta (`bun run packages/web/watcher/agent.ts`)

### Verificar o estado da ligação via API
```bash
curl -s http://localhost:4200/api/bank/status --cookie "<cookie-de-sessão-do-browser>"
```

### Forçar uma sincronização com período customizado (backfill)
O endpoint aceita um body opcional `{ date_from, date_to }` — sem isso, faz sync incremental desde o último log (o que dá `0 transações` se já tiveres sincronizado há pouco tempo, como aconteceu no primeiro teste). Para puxar o histórico completo disponível (a Enable Banking/Santander limita a **89 dias** para trás), corre isto na **consola do browser**, já autenticado, na página da app:

```js
fetch("/api/bank/sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    date_from: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    date_to: new Date().toISOString().slice(0, 10),
  }),
}).then(r => r.json()).then(console.log);
```

Isto ingere todas as transações dos últimos 89 dias, corre o motor de reconciliação (Matriz de Identidade + fallback LLM), cria/atualiza quotas e despesas, e recalcula os saldos do dashboard.

---

## 5. Arquitetura da integração bancária (`packages/web/src/api/routes/bank.ts`)

```
GET    /api/bank/status          → estado da ligação + último sync
GET    /api/bank/connect         → inicia consent (POST /auth na Enable Banking, devolve authUrl)
GET    /api/bank/callback        → recebe o code, troca por sessão (POST /sessions), guarda accounts
POST   /api/bank/sync            → busca transações (incremental ou período custom) + importa
DELETE /api/bank/disconnect      → remove a ligação da BD
POST   /api/bank/process-staged  → reprocessa transações em staging (imported=0)
GET    /api/bank/synclogs        → histórico de syncs
```

**Fluxo de autenticação**: JWT assinado com RS256 (`kid = CLIENT_ID`, chave privada RSA), sessão trocada via `POST /sessions` com o `code` do callback. Não há refresh token — é um modelo de sessão com validade (`valid_until`, pedimos 90 dias, mas o Santander/Enable Banking pode limitar por baixo disso).

**Sincronização**: só polling (cron a cada poucas horas + sync automático no arranque do servidor + debounce de 5 min no frontend). Sem webhooks — não são suportados nesta integração.

**Motor de importação** (`importTransactions` em `bank.ts`):
1. Staging: todas as transações cruas são gravadas em `bank_transactions` (dedup por `transaction_id`)
2. Barreira 1 — Matriz de Identidade (`identity-matrix.ts`): tenta identificar a fração por IBAN aprendido, nome do devedor, valor e descrição. Confiança ≥ 55% → cria/atualiza quota automaticamente.
3. Fallback regex simples (compatibilidade legacy) para casos como "Motor Garagem"
4. Camada 2 — fallback LLM (Groq/OpenRouter) para o que sobra sem match
5. O que não é identificado por nenhuma camada fica marcado `requires_manual_review = 1`

**Cascata de amortização**: pagamentos acima da quota do mês corrente amortizam dívidas antigas da mesma fração automaticamente.

---

## 6. Incidentes resolvidos nesta sessão (histórico de debugging)

Para referência futura — todos estes já foram diagnosticados e corrigidos:

| # | Sintoma | Causa raiz | Resolução |
|---|---------|-----------|-----------|
| 1 | Dashboard mostrava "sincronizado" mesmo sem dados novos do banco | `POST /sync` devolvia sempre `HTTP 200 + ok:true`, mesmo com falha total; `useBankSync.ts` só olhava para o status HTTP, não para `syncErrors` no body | Commit `b18f43c`: `/sync` devolve `502 + ok:false` em falha total; hook lê `syncErrors`/`ok` do body |
| 2 | `/api/bank/status` dizia "connected" mesmo com sessão expirada/revogada | Só verificava se existia registo na BD, nunca o `status` real | `connected = status === "active"`; novo campo `needsReconnect` |
| 3 | Callback gravava sempre `bankName: "Santander Empresas PT"` mesmo se tivesse ligado ao Mock ASPSP (sandbox) | Valor hardcoded, não refletia o ASPSP real usado no `/connect` | Grava o valor real de `ENABLE_BANKING_ASPSP_NAME` |
| 4 | Chave privada real (`.pem`) commitada no repositório público desde o commit inicial | Ficheiro nunca devia ter sido versionado | Certificado revogado e substituído pelo utilizador; `.pem` a remover do histórico do git |
| 5 | `422 WRONG_ASPSP_PROVIDED` | `ENABLE_BANKING_ASPSP_NAME="Santander Totta (PT)"` não é um valor válido — confirmado por chamada real a `GET /aspsps?country=PT` que o nome certo é `Santander Totta` | Corrigido no `.env` |
| 6 | `error:1E08010C:DECODER routines::unsupported` ao assinar o JWT | Chave privada com header `RSA PRIVATE KEY` (PKCS1) mas conteúdo `EncryptedPrivateKeyInfo`/PKCS8 — mismatch de formato | Chave nova exportada corretamente como PKCS8 sem cifra, header `PRIVATE KEY` |
| 7 | `404 ACCOUNT_DOES_NOT_EXIST` | UID de conta guardado na BD era de uma sessão antiga/inválida (criada antes da chave estar correta) | Desconectar + reconectar com consent novo |
| 8 | `400 REDIRECT_URI_NOT_ALLOWED` | `ENABLE_BANKING_REDIRECT_URI` não batia byte a byte com nenhum URL da allowlist do portal | Alinhado o `.env` com o URL exato registado |
| 9 | `unsupported scheme` no redirect URI | Enable Banking rejeita `http://` mesmo em localhost — exige HTTPS | Túnel `ngrok http 4200`, redirect URI e allowlist atualizados para o URL HTTPS do túnel |

**Estado atual: ligação Santander Totta ativa e a funcionar** (confirmado — ver print de `Importar Dados` com "Santander Totta — Ligado").

---

## 7. Base de Dados

```bash
cd packages/web
bun run db:push        # Sincronizar schema com a DB
bun run db:generate    # Gerar ficheiros de migração
bun run db:migrate     # Correr migrações
bun run db:studio      # Abrir Drizzle Studio
```

## 8. Dev

```bash
bun install
bun run dev            # Servidor unificado (API + frontend), porta 4200
bun run dev:mobile     # Expo
bun run dev:desktop    # Electron
```

## 9. Próximos passos sugeridos

- [ ] Forçar o backfill completo de 89 dias (ver secção 4) para puxar todo o histórico disponível do Santander Empresas
- [ ] Validar visualmente no Dashboard/Morosos/Relatórios que os valores batem certo com o extrato real do banco
- [ ] Remover definitivamente o `.pem` do histórico do git (`git filter-repo`) e confirmar que o certificado antigo foi revogado no portal
- [ ] Considerar registar um domínio/subdomínio fixo (em vez do ngrok efémero) para testes recorrentes, ou testar já diretamente contra o domínio de produção final
