/**
 * As mesmas dez representações de docs/lumen/F1-INGEST-EXEMPLOS.md.
 * Todas descrevem A=600‰ e B=400‰.
 */

export type DiverseDocument = {
  id: string;
  filename: string;
  origem: "table" | "key_value" | "prose";
  transform: "identity_permille" | "percent_to_permille:*10";
  originalA: string;
  text: string;
};

export const DIVERSE_DOCUMENTS: DiverseDocument[] = [
  {
    id: "01-csv",
    filename: "unidades.csv",
    origem: "table",
    transform: "identity_permille",
    originalA: "600",
    text: "codigo,permilagem\nA,600\nB,400\n",
  },
  {
    id: "02-semicolon",
    filename: "milesimas.csv",
    origem: "table",
    transform: "identity_permille",
    originalA: "600",
    text: "Fracção;Milésimas\nA;600\nB;400\n",
  },
  {
    id: "03-dotted",
    filename: "lideres.txt",
    origem: "prose",
    transform: "identity_permille",
    originalA: "600",
    text: "Fracção A ........ 600 milésimas\nFracção B ........ 400 milésimas\n",
  },
  {
    id: "04-percent",
    filename: "percentagem.csv",
    origem: "table",
    transform: "percent_to_permille:*10",
    originalA: "60",
    text: "Unidade,Percentagem\nA,60\nB,40\n",
  },
  {
    id: "05-markdown",
    filename: "tabela.md.txt",
    origem: "table",
    transform: "identity_permille",
    originalA: "600",
    text: "| Letra | Permilagem |\n| --- | --- |\n| A | 600 |\n| B | 400 |\n",
  },
  {
    id: "06-tsv",
    filename: "permille.tsv.txt",
    origem: "table",
    transform: "identity_permille",
    originalA: "600",
    text: "code\tpermille\nA\t600\nB\t400\n",
  },
  {
    id: "07-key-value",
    filename: "blocos.txt",
    origem: "key_value",
    transform: "identity_permille",
    originalA: "600",
    text: "Fração: A\nPermilagem: 600\n\nFração: B\nPermilagem: 400\n",
  },
  {
    id: "08-equals",
    filename: "igual.txt",
    origem: "prose",
    transform: "identity_permille",
    originalA: "600",
    text: "A = 600 milésimas\nB = 400 milésimas\n",
  },
  {
    id: "09-aligned",
    filename: "alinhado.txt",
    origem: "table",
    transform: "identity_permille",
    originalA: "600",
    text: "codigo  permilagem\nA       600\nB       400\n",
  },
  {
    id: "10-notarial",
    filename: "notarial.txt",
    origem: "prose",
    transform: "identity_permille",
    originalA: "600",
    text: "A fracção autónoma designada pela letra A corresponde a 600 milésimas.\nA fracção autónoma designada pela letra B corresponde a 400 milésimas.\n",
  },
];

export const AMBIGUOUS_VALOR = "codigo,valor\nA,600\nB,400\n";

export const COVERAGE_GAP = [
  "Fracção A ........ 600 milésimas",
  "Fracção B ........ 400 milésimas",
  "Fracção C ........ a preencher",
  "",
].join("\n");

export const MIXED_UNITS = "Fracção A — 600‰\nFracção B — 40%\n";

export const SUM_MISMATCH = "codigo,permilagem\nA,600\nB,300\n";
