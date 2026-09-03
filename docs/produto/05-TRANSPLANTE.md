# 05 — Transplante da Branch `dev` (Dadora de Órgãos)

> A branch `dev` é a app em produção para a Urbanização da Fonte.
> Não se refaz em cima dela. Transplanta-se apenas o que faz sentido para o produto genérico.

## Inventário do que existe em `dev`

### Código transplantável (por especialidade)

#### Financeiro
| Ficheiro | Linhas | O que faz | Adaptação necessária |
|----------|--------|-----------|---------------------|
| `lib/reconciliation-engine.ts` | 586 | Motor de reconciliação banco ↔ frações (3 camadas) | Remover hardcode Fonte; parametrizar por tenant |
| `lib/csv-bank-parser.ts` | 551 | Parser CSV Santander + detecção formato | Adicionar parsers para outros bancos |
| `lib/llm-fallback.ts` | 298 | Camada 2: LLM identifica transações não matched | Reutilizar como está; ajustar prompts |
| `lib/identity-matrix.ts` | ~1200 | Matriz de identidade (IBANs, nomes, aliases) + cascata | Extrair cascata como módulo; remover dados Fonte |
| `lib/transfer-match.ts` | ~540 | Aplica match: paga extra ou corre cascata | Reutilizar; depende de identity-matrix |
| `routes/bank.ts` | ~1200 | Enable Banking + sync + chunks 30 dias | Reutilizar; parametrizar ASPSP por tenant |
| `routes/recibos.ts` | 757 | Geração PDF recibos + envio | Remover hardcode morada Fonte; template por tenant |
| `routes/relatorio.ts` | — | Relatórios mensais automáticos | Reutilizar |
| `lib/rateio.ts` | — | Rateio de despesas por permilagem | Reutilizar como está |

#### Assembleia (atas + votos + transcrição)
| Ficheiro | O que faz | Adaptação |
|----------|-----------|-----------|
| `lib/stt.ts` | Whisper STT com chunk 25MB (ffmpeg split) | Reutilizar como está |
| `lib/atas-llm.ts` | LLM gera acta a partir de transcrição | Reutilizar; ajustar system prompt |
| `lib/reuniao-llm.ts` | LLM para resumo/análise de reunião | Reutilizar |
| `lib/ata-conteudo.ts` | Estrutura conteúdo da acta | Reutilizar |
| `lib/ata-formato.ts` | Formatação da acta | Reutilizar |
| `lib/ata-pdf.ts` | Gera PDF da acta | Reutilizar; template genérico |
| `lib/reuniao-pdf.ts` | Gera PDF do resumo reunião | Reutilizar |
| `routes/atas.ts` | CRUD atas + votação | Reutilizar; adicionar lógica quórum |
| `routes/reunioes.ts` | CRUD reuniões + upload áudio | Reutilizar |

#### Operações (tickets + foto + email)
| Ficheiro | O que faz | Adaptação |
|----------|-----------|-----------|
| `lib/ticket-llm.ts` | LLM categoriza/prioriza tickets | Reutilizar |
| `lib/ticket-email.ts` | Email de notificação de ticket | Mover para módulo Comunicação |
| `lib/email-ticket-pipeline.ts` | IMAP → triagem LLM → ticket | Reutilizar |
| `lib/email-llm.ts` | LLM triagem de emails recebidos | Reutilizar |
| `routes/tickets.ts` | CRUD tickets + fotos + aprovação | Reutilizar |
| `routes/uploads.ts` | Upload chunked (6MB chunks) | Ajustar limites; reutilizar |

### Schema (BD)
| Ficheiro | Notas |
|----------|-------|
| `database/schema.ts` | Schema Drizzle — base para multi-tenant; extrair dados Fonte |
| `database/seed-*.ts` | Seeds específicos da Fonte — NÃO transplantar; criar seed genérico |

### O que NÃO transplantar

| Item | Razão |
|------|-------|
| `lib/condominio.ts` | Config hardcoded da Urbanização da Fonte |
| `lib/cartas-julho-2026.ts` | Cartas específicas da Fonte |
| `lib/identity-matrix.ts` (dados) | IBANs/nomes/permilagens da Fonte — só a lógica |
| `routes/seed.ts` | Seed com dados reais da Fonte |
| `database/seed-*.ts` | Seeds com dados reais |
| `scripts/import-excel-2026.ts` | Importação de Excel específico |
| `scripts/seed-dividas.ts` | Dívidas reais da Fonte |
| `_archive/` | Mobile/Desktop legado |
| `App_trade` | Excluído por instrução |
| `condominio_buildingmind_v2` | Excluído por instrução |
| Design dark (design.md) | Produto usa palette creme + coral + terracota |

### Frontend (páginas)

As páginas de `dev` servem como referência mas serão reescritas com o novo design (creme/coral/terracota PWA):

| Página | Transplante |
|--------|-------------|
| `pages/portal.tsx` | Lógica de portal condómino → base para QR portal |
| `pages/quotas.tsx` | Lógica financeira → adaptar |
| `pages/movimentos-bancarios.tsx` | Reconciliação UI → adaptar |
| `pages/atas.tsx` | UI atas/votos → reescrever com novo design |
| `pages/reunioes.tsx` | UI reuniões → reescrever |
| `pages/pedidos.tsx` | UI tickets → reescrever |
| `pages/recibos.tsx` | UI recibos → adaptar |
| Restantes páginas | Reescrever para multi-tenant + novo design |
