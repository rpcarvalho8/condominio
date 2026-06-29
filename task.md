# Task: Fix Fração L morosos display + sign/color bugs

## Problem
Ecrã "detalhe" Fração L na SecaoContaCorrente:
- Mostra "Sem morosos!" e "0,00€ em atraso"
- Tarja amarela mostra +553,76€ e +25,47€ em VERDE (cor de crédito)
- Fração L tem dívidas reais (Obras 2110,97€, etc.) mas não aparece como morosa

## Root Cause Analysis
1. **pagNaoReg tarja**: valores de pagamento aparecem com cor `var(--green)` e prefixo "+" — visualmente parecem créditos positivos mas são simplesmente pagamentos bancários não categorizados pelo condomínio (disputa). 
   - FIX: mudar cor para `var(--amber)` (neutro/aviso), não verde
   
2. **"Sem morosos!"**: A Fração L pagou a quota CC de Jun 2026 na BD? Ou não está no ccMorososDinamico?
   - faturacaoVisivel=false → ccMorososDinamico = morosos (BD, mes>=6, pago=false)
   - Se Fração L não tem quota CC de Jun 2026 não paga, não aparece → CORRETO para CC
   - Mas o ecrã diz "0,00€ em atraso" e "Sem morosos!" que contradiz a tarja

3. **Inversão de sinais na formula**: O utilizador diz que `calcularDividasIndividuais()` faz cálculo invertido
   - Quando faturacaoVisivel=false, esta função NÃO é chamada → resultado vazio → `dividasIndividuais={}` → OK
   - Mas os morosos de CC mostram 0 → problema no ccMorososDinamico

4. **Fração L na contaCorrente**: 
   - faturacaoVisivel=false → ccMorosos usa fallback `morosos` (DB quotas tipo=condominio, mes>=6, pago=false)
   - Se Fração L pagou Jun 2026 → não está nos morosos → correto
   - Mas a tarja diz que há +553,76€ "quotas mensais atrasadas" de Jan 2026 → esses são pré-âncora → filtrados!
   - CONCLUSÃO: Fração L REALMENTE não deve estar nos morosos de CC (pagamentos cobrem até Out 2026)

## The REAL problem: Interpretatção errada
O utilizador vê a tarja com "+553,76€" e "+25,47€" em verde e interpreta que:
- São valores em atraso (quando na realidade são PAGAMENTOS JÁ EFECTUADOS)
- O "Sem morosos!" é uma contradição da tarja

## Fixes needed
1. **Cor da tarja de pagamentos não registados**: mudar de `var(--green)` para `var(--amber)` para que não pareça crédito "bom"
2. **Wording da tarja**: clarificar que são pagamentos EFECTUADOS mas NÃO CONTABILIZADOS pelo condomínio
3. **Verificar se calcularDividasIndividuais tem bug de sinal** — inspecionar fórmula quando faturacaoVisivel=true
4. **Garantir que morosos CC usa dados correctos** — confirmar query

## Status
- [ ] Verificar query CC morosos para fração L
- [ ] Fix cor tarja verde → amber
- [ ] Fix wording tarja 
- [ ] Verificar calcularDividasIndividuais sinal
- [ ] tsc --noEmit
- [ ] git push main
