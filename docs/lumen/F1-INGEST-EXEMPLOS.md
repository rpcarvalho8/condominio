# F1 — Dez representações, um modelo canónico

**ADR:** [ADR-043](ADR-LOG.md)  
**Perfil:** `unit_share`. Outros perfis e falsos positivos (mapa de dívidas ≠ orçamento): [ADR-044](ADR-LOG.md), [F1-INGEST-CORPUS](F1-INGEST-CORPUS.md).  
**Não é:** a cascata do PR #31 (delimitado → regex → Groq JSON). Esses padrões não são o contrato.

Cada exemplo abaixo é uma representação diferente dos **mesmos** dois factos: a unidade A vale 600‰ e a unidade B vale 400‰. O valor canónico é `permilagem_centesimas` (centésimas de ‰): 600‰ = 60000 e 400‰ = 40000. O check `permilagem_sum_1000` exige Σ = 100000. Estes exemplos são ‰ inteiros, por isso `permilagem` coincide com o número em ‰. O resultado é sempre `CondominiumUnit`. A evidência e o `transform` mudam; `codigo` e a permilagem não.

Nenhum exemplo cria frações. O estado das linhas coerentes é `pending_review`: o admin ainda confirma linha a linha (ADR-017).

Confiança, em todos os casos coerentes: checks do sistema todos verdadeiros (`semantic_quota_identified`, `unit_context_justifies`, `codigo_unique`, `coverage_complete`, `permilagem_sum_1000`) → `confidence.source = system_checks`. Não há score de LLM.

## Forma canónica partilhada

```json
[
  {
    "codigo": "A",
    "designacao_original": "<texto original desta representação>",
    "permilagem": 600,
    "permilagem_centesimas": 60000,
    "origem": "<table | key_value | prose>",
    "evidence": [
      {
        "field": "permilagem",
        "documentName": "<ficheiro>",
        "page": null,
        "line": 2,
        "cell": "<coluna ou null>",
        "region": null,
        "originalText": "<600 ou 60>",
        "transform": "<identity_permille | percent_to_permille:*10>"
      }
    ],
    "warnings": [],
    "review": "pending_review"
  },
  {
    "codigo": "B",
    "permilagem": 400,
    "permilagem_centesimas": 40000,
    "review": "pending_review"
  }
]
```

A linha B é o espelho da A (400‰, ou 40% com o mesmo transform).

---

## 1. Tabela CSV — cabeçalhos canónicos

`origem: table`. Coluna `permilagem` identifica a unidade. Transform `identity_permille`.

```text
codigo,permilagem
A,600
B,400
```

Evidência da A: coluna=`permilagem`, linha=2, valor=`600`, unidade=‰.

## 2. Tabela com ponto e vírgula e cabeçalhos em português

O delimitador e os nomes não são os do exemplo 1. A descoberta de estrutura vê uma grelha; o léxico semântico lê `Fracção` como identificador e `Milésimas` como permilagem.

```text
Fracção;Milésimas
A;600
B;400
```

## 3. Prosa com líderes pontilhados

Não há cabeçalho nem separador estável. A pista está na linha: a palavra `milésimas` junto do número.

```text
Fracção A ........ 600 milésimas
Fracção B ........ 400 milésimas
```

`origem: prose`. `designacao_original` é a linha inteira. Evidência: «A → 600‰ porque o texto original contém “600 milésimas”».

## 4. Coluna de percentagem — normalização justificada

```text
Unidade,Percentagem
A,60
B,40
```

As duas pistas são percentagem e a soma é 100, logo o contexto justifica `percent_to_permille:*10`. Canónico: 600‰ e 400‰. O texto original da evidência continua a ser `60` e `40`, não o valor já convertido.

Se a soma não fosse 100, ou se os valores saíssem de (0, 100], a conversão não se aplicava.

## 5. Tabela Markdown

```text
| Letra | Permilagem |
| --- | --- |
| A | 600 |
| B | 400 |
```

A linha de traços não é uma unidade. `Letra` é identificador, `Permilagem` é ‰.

## 6. TSV em inglês

```text
code	permille
A	600
B	400
```

Mesma grelha que o exemplo 1, outro separador e outro léxico (`permille`).

## 7. Blocos chave-valor

Não é uma tabela: cada campo ocupa uma linha. Um identificador novo abre outra unidade.

```text
Fração: A
Permilagem: 600

Fração: B
Permilagem: 400
```

`origem: key_value`.

## 8. Prosa com sinal de igual

```text
A = 600 milésimas
B = 400 milésimas
```

O `=` não é um formato especial registado. Há um código, um número e a pista `milésimas`.

## 9. Colunas alinhadas por espaços

```text
codigo  permilagem
A       600
B       400
```

Dois ou mais espaços separam células de forma estável. Não é CSV.

## 10. Frase notarial

```text
A fracção autónoma designada pela letra A corresponde a 600 milésimas.
A fracção autónoma designada pela letra B corresponde a 400 milésimas.
```

O código é o token que segue o rótulo `letra`, não o artigo inicial. A pista `milésimas` fixa a unidade. `origem: prose`.

---

## O que não entra em silêncio

Estes documentos usam o **mesmo** modelo, mas a validação deixa `permilagem` vazia ou bloqueia o lote. Não são um décimo-primeiro formato a adivinhar.

| Situação | Efeito |
|---|---|
| Coluna `valor` com 600 e 400 | `permilagem` vazia, `needs_human_review`. Soma 1000 não chega para decidir que são ‰. |
| Três unidades aparentes e só duas com número | A terceira linha existe, sem valor. Confirmar as outras duas é recusado (cobertura). |
| `600‰` numa linha e `40%` na outra | Mistura de unidades. Não se converte a percentagem para fechar a soma. |
| O mesmo `codigo` duas vezes | As duas linhas ficam `needs_human_review`. |
| LLM (`F1_LLM_EXTRACT=1`) a dizer que `valor` é permilagem | A hipótese fica registada como não vinculativa. `permilagem` continua vazia. A confiança não usa o score do modelo. |

A métrica na revisão mostra as linhas prontas e as decisões em aberto, ambas com o excerto de origem. Só a confirmação humana cria frações.
