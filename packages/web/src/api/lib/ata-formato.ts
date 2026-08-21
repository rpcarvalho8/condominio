import type { AtaConteudo, AtaPonto } from "./ata-conteudo";

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const DEZ_A_DEZENOVE = [
  "dez", "onze", "doze", "treze", "catorze", "quinze",
  "dezasseis", "dezassete", "dezoito", "dezanove",
];
const DEZENAS = ["", "", "vinte", "trinta"];

function numeroPorExtenso(n: number): string {
  if (n <= 0) return "";
  if (n < 10) return UNIDADES[n] ?? String(n);
  if (n < 20) return DEZ_A_DEZENOVE[n - 10] ?? String(n);
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    const dezena = DEZENAS[d];
    if (!dezena) return String(n);
    return u === 0 ? dezena : `${dezena} e ${UNIDADES[u]}`;
  }
  return String(n);
}

export function anoPorExtenso(year: number): string {
  if (year >= 2000 && year < 2100) {
    const rest = year - 2000;
    if (rest === 0) return "dois mil";
    return `dois mil e ${numeroPorExtenso(rest)}`;
  }
  return String(year);
}

export function partesData(dataISO: string): { dia: string; mes: string; anoExtenso: string } {
  const d = new Date(`${dataISO.slice(0, 10)}T12:00:00`);
  const day = d.getDate();
  const month = d.getMonth();
  const year = d.getFullYear();
  return {
    dia: String(day),
    mes: MESES[month] ?? "",
    anoExtenso: anoPorExtenso(year),
  };
}

function votosPorExtenso(v: { favor: number; contra: number; abstencao: number }): string {
  const parts: string[] = [];
  if (v.favor > 0) parts.push(`${v.favor} votos a favor`);
  if (v.contra > 0) parts.push(`${v.contra} votos contra`);
  if (v.abstencao > 0) parts.push(`${v.abstencao} abstenções`);
  if (parts.length === 0) return "";
  return parts.join(", ");
}

/** Texto narrativo formal de um ponto (fallback se LLM não preencheu `texto`). */
export function buildPontoTexto(ponto: AtaPonto, index: number): string {
  if (ponto.texto?.trim()) return ponto.texto.trim();

  const titulo = ponto.titulo.trim() || `assunto ${index + 1}`;
  const discussao = ponto.discussao.trim();
  const deliberacao = ponto.deliberacao.trim();
  const votos = votosPorExtenso(ponto.votos);

  let body = "";
  if (discussao) {
    body = discussao.endsWith(".") ? discussao : `${discussao}.`;
  } else {
    body = `Procedeu-se à discussão de ${titulo}.`;
  }

  if (deliberacao) {
    const del = deliberacao.endsWith(".") ? deliberacao : `${deliberacao}.`;
    body += ` ${del}`;
  }

  if (votos) {
    body += ` Após submissão a votação, recolheu ${votos}.`;
  } else if (!deliberacao) {
    body += " Após discussão e consequente votação, a deliberação ficará a completar.";
  }

  return body;
}

function linhaOrdemTrabalhos(index: number, titulo: string): string {
  const t = titulo.trim().replace(/[.;]+$/, "");
  return `${index + 1}. ${t};`;
}

/** Gera o texto integral da ata no formato legal português. */
export function conteudoToTextoFormal(conteudo: AtaConteudo): string {
  const h = conteudo.cabecalho;
  const data = partesData(h.dataReuniao);
  const conv = partesData(h.convocatoriaData || h.dataReuniao);

  const tipo = h.tipoAssembleia.trim() || "Ordinária";
  const local = h.localReuniao.trim() || "sala do condomínio";
  const horaInicio = h.horaInicio.trim() || "……………………";
  const horaFim = h.horaFim.trim() || "………………";
  const nomeFormal = h.nomeCondominioFormal.trim() || h.nomeCondominio.trim();
  const morada = h.morada.trim();
  const freguesia = h.freguesia.trim() || "……………………………………";
  const concelho = h.concelho.trim() || "…………………………………………";
  const presidente = h.presidente.trim() || "…………………………………………………………………………";
  const secretario = h.secretario.trim() || "……………………………………………………";
  const presentes = h.presentes.trim() || "(…)";

  const linhas: string[] = [];

  linhas.push(
    `No dia ${data.dia} de ${data.mes} de ${data.anoExtenso}, pelas ${horaInicio} horas, reuniu na ${local}, a Assembleia Geral ${tipo} de Condóminos do ${nomeFormal}, prédio constituído em regime de propriedade horizontal, sito ${morada}, na freguesia de ${freguesia}, concelho de ${concelho}, convocada pelo Administrador em ${conv.dia} de ${conv.mes} de ${conv.anoExtenso}, através de envio de carta registada com a antecedência mínima de dez dias, para deliberar sobre os seguintes assuntos constantes da Ordem de Trabalhos:`,
    "",
  );

  if (conteudo.pontos.length === 0) {
    linhas.push(
      "1. Apresentação, discussão e votação do Relatório e Contas do exercício de …………………………………………………………………;",
      "2. Eleição da Administração para o exercício de ………………………………………………;",
      "3. Discussão e votação do Orçamento para o exercício de …………………………………………;",
      "4. Discussão de outros assuntos de interesse para o Condomínio.",
    );
  } else {
    conteudo.pontos.forEach((p, i) => linhas.push(linhaOrdemTrabalhos(i, p.titulo)));
  }

  linhas.push(
    "",
    "Encontravam-se presentes e/ou representados os seguintes condóminos:",
    presentes,
    "conforme lista de presenças anexa e credenciais de representação arquivadas.",
    "",
    `Presidiu à Assembleia o Administrador, ${presidente}, tendo exercido as funções de secretário o condómino ${secretario}`,
    "",
    h.textoAbertura?.trim() ||
      "Verificada a regularidade da convocatória e a presença de um número de condóminos representativo dos votos necessários à tomada de deliberações, o Administrador abriu a sessão, dando início aos trabalhos da Assembleia, de harmonia com a respectiva ordem constante da convocatória:",
    "",
  );

  conteudo.pontos.forEach((p, i) => {
    const texto = buildPontoTexto(p, i);
    linhas.push(`PONTO ${i + 1} – ${texto}`, "");
  });

  linhas.push(
    h.textoEncerramento?.trim() ||
      `Nada mais havendo a tratar, foram os trabalhos dados como concluídos pelas ${horaFim} horas, lavrando-se a presente ata que, após lida e aprovada, vai ser assinada pelo Presidente, pelo Secretário e por todos os condóminos presentes e/ou representados, enviando-se de seguida uma cópia a todos os condóminos ausentes.`,
  );

  return linhas.join("\n");
}
