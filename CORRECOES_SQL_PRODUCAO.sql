-- ═══════════════════════════════════════════════════════════════════════
-- Correções a correr manualmente na BD de PRODUÇÃO via Drizzle Studio
-- (SQL Console) — o agente não tem acesso direto a esta base de dados.
-- Corre cada bloco NA ORDEM, um de cada vez, e confirma o resultado antes
-- de avançar para o próximo.
-- ═══════════════════════════════════════════════════════════════════════

-- ── PASSO 1: Confirmar as 3 linhas duplicadas antes de apagar ────────────
SELECT id, transaction_id, amount, description, date, import_ref_id, imported
FROM bank_transactions
WHERE amount = 29.53 AND description LIKE '%COUTINHO%';
-- Deves ver 3 linhas com IDs:
--   50694cd1-2fb7-4bf8-9464-16d30b968d4c
--   8280e636-dd4e-4eed-928e-a293eae2b0a5
--   cf8e3582-e4fe-4a92-a792-ca801cd65b70

-- ── PASSO 2: Apagar 2 das 3 linhas duplicadas (manter só a primeira) ─────
DELETE FROM bank_transactions
WHERE id IN (
  '8280e636-dd4e-4eed-928e-a293eae2b0a5',
  'cf8e3582-e4fe-4a92-a792-ca801cd65b70'
);

-- ── PASSO 3: Reclassificar a quota da Fração L de "condominio" para      --
-- "extra"/Motor (confirmado pelo condómino via email) ────────────────────
-- Substitui '<MOTOR_QUOTA_TIPO_ID>' pelo ID real do quotaTipo "Motor" —
-- corre esta query primeiro para descobrires o ID certo:
SELECT id, nome, tipo, keywords FROM quota_tipos WHERE tipo = 'extra';

-- Depois de teres o ID do Motor, corre:
UPDATE quotas
SET tipo = 'extra',
    quota_tipo_id = '<MOTOR_QUOTA_TIPO_ID>',
    observacoes = '[reclassificado manualmente: Motor — confirmado por email do condómino em 22/07/2026] ' || observacoes
WHERE id = '11c1a792-1193-49e5-a65c-698aa1d3a12e';

-- ── PASSO 4: Confirmar que ficou tudo correto ────────────────────────────
SELECT id, transaction_id, amount, description, imported FROM bank_transactions
WHERE amount = 29.53 AND description LIKE '%COUTINHO%';
-- Deve devolver só 1 linha agora

SELECT q.*, f.numero FROM quotas q
JOIN fracoes f ON f.id = q.fracao_id
WHERE f.numero = 'L' ORDER BY q.created_at DESC LIMIT 5;
-- A quota 11c1a792... deve aparecer agora com tipo='extra'

-- ── PASSO 5: Recalcular saldos depois da limpeza ─────────────────────────
-- Não é SQL — depois de correres os passos acima, chama o endpoint (autenticado,
-- na app já com o código novo publicado):
--   POST /api/dashboard/recalcular
-- ou simplesmente clica "Sincronizar agora" na página Importar — o
-- recalcularSaldos() corrigido vai reprocessar tudo com os dados já limpos.
