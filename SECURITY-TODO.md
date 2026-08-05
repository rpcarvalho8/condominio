# Ficheiros com dados pessoais a limpar

- identity-matrix.ts → contém nomes, IBANs, fracções reais
- seed.ts → contém dados do Condomínio 7663
- llm-fallback.ts
- bank.ts
- recibos.ts
- relatorio.ts
- dashboard.ts
- identity.ts
- avisos.ts
- cativo-rules.ts
- schema.ts
- test-desempate-af.ts
- test-sync-simulation.ts
- inject-qa-v2-turso.ts

### Ficheiros em node_modules (verificar/ignorar):
- Constants.server.ts
- Constants.ts
- ExponentConstants.web.ts
- decode-data-html.ts
- defaults.d.ts
- lib.dom.d.ts
- lib.webworker.d.ts
- function-module.d.ts

## Lista completa de Caminhos:
- `./packages/web/src/api/lib/llm-fallback.ts`
- `./packages/web/src/api/lib/identity-matrix.ts`
- `./packages/web/src/api/routes/bank.ts`
- `./packages/web/src/api/routes/recibos.ts`
- `./packages/web/src/api/routes/relatorio.ts`
- `./packages/web/src/api/routes/dashboard.ts`
- `./packages/web/src/api/routes/identity.ts`
- `./packages/web/src/api/routes/avisos.ts`
- `./packages/web/src/api/routes/cativo-rules.ts`
- `./packages/web/src/api/database/schema.ts`
- `./packages/web/scripts/test-desempate-af.ts`
- `./packages/web/scripts/test-sync-simulation.ts`
- `./node_modules/.bun/expo-constants@18.0.13+01e30e4ce267adc8/node_modules/expo-constants/src/Constants.server.ts`
- `./node_modules/.bun/expo-constants@18.0.13+01e30e4ce267adc8/node_modules/expo-constants/src/Constants.ts`
- `./node_modules/.bun/expo-constants@18.0.13+01e30e4ce267adc8/node_modules/expo-constants/src/ExponentConstants.web.ts`
- `./node_modules/.bun/entities@8.0.0/node_modules/entities/src/generated/decode-data-html.ts`
- `./node_modules/.bun/metro-config@0.83.5/node_modules/metro-config/src/defaults/defaults.d.ts`
- `./node_modules/.bun/expo-constants@18.0.13+6b7ef1165bf48b92/node_modules/expo-constants/src/Constants.server.ts`
- `./node_modules/.bun/expo-constants@18.0.13+6b7ef1165bf48b92/node_modules/expo-constants/src/Constants.ts`
- `./node_modules/.bun/expo-constants@18.0.13+6b7ef1165bf48b92/node_modules/expo-constants/src/ExponentConstants.web.ts`
- `./node_modules/.bun/expo-constants@18.0.13+e4fd16ac8ffee978/node_modules/expo-constants/src/Constants.server.ts`
- `./node_modules/.bun/expo-constants@18.0.13+e4fd16ac8ffee978/node_modules/expo-constants/src/Constants.ts`
- `./node_modules/.bun/expo-constants@18.0.13+e4fd16ac8ffee978/node_modules/expo-constants/src/ExponentConstants.web.ts`
- `./node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/lib.dom.d.ts`
- `./node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/lib.webworker.d.ts`
- `./node_modules/.bun/metro-config@0.83.3/node_modules/metro-config/src/defaults/defaults.d.ts`
- `./node_modules/.bun/kysely@0.28.16/node_modules/kysely/dist/cjs/query-builder/function-module.d.ts`
- `./node_modules/.bun/kysely@0.28.16/node_modules/kysely/dist/esm/query-builder/function-module.d.ts`
- `./node_modules/.bun/@expo+metro@54.2.0/node_modules/@expo/metro/metro-config/defaults/defaults.d.ts`
- `./inject-qa-v2-turso.ts`

## A fazer na Quarta:
- Mover dados para identity-data.json (fora do Git)
- Criar seed que lê da BD
- Apagar dados hardcoded