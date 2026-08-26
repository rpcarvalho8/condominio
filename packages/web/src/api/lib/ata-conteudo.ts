import { CONDOMINIO } from "./condominio";
import { conteudoToTextoFormal } from "./ata-formato";

/** Vote counts per agenda point — manual now; future: auto-fill from ata_votes. */
export type AtaVotosPonto = {
  favor: number;
  contra: number;
  abstencao: number;
  /** "manual" until integrated with condómino approval voting (ata_votes). */
  source: "manual" | "ata_votes";
  autoFilledAt?: string | null;
  ataVotesSnapshotAt?: string | null;
};

export type AtaPonto = {
  id: string;
  /** Item da ordem de trabalhos (ex.: "Apresentação, discussão e votação do Relatório e Contas...") */
  titulo: string;
  /** Parágrafo formal completo do PONTO N (preferencial). */
  texto: string;
  discussao: string;
  deliberacao: string;
  votos: AtaVotosPonto;
};

export type AtaCabecalho = {
  nomeCondominio: string;
  nomeCondominioFormal: string;
  morada: string;
  localidade: string;
  nif: string;
  freguesia: string;
  concelho: string;
  dataReuniao: string;
  horaInicio: string;
  horaFim: string;
  localReuniao: string;
  tipoAssembleia: string;
  /** Data ISO (YYYY-MM-DD) da convocatória */
  convocatoriaData: string;
  presidente: string;
  secretario: string;
  presentes: string;
  textoAbertura?: string;
  textoEncerramento?: string;
};

export type AtaConteudo = {
  version: 1;
  cabecalho: AtaCabecalho;
  pontos: AtaPonto[];
};

export function defaultVotos(): AtaVotosPonto {
  return { favor: 0, contra: 0, abstencao: 0, source: "manual" };
}

export function defaultCabecalho(dataReuniao: Date): AtaCabecalho {
  const iso = dataReuniao.toISOString().slice(0, 10);
  return {
    nomeCondominio: CONDOMINIO.nome,
    nomeCondominioFormal: CONDOMINIO.nomeFormal,
    morada: CONDOMINIO.morada,
    localidade: CONDOMINIO.localidade,
    nif: CONDOMINIO.nif,
    freguesia: CONDOMINIO.freguesia,
    concelho: CONDOMINIO.concelho,
    dataReuniao: iso,
    horaInicio: "",
    horaFim: "",
    localReuniao: CONDOMINIO.localReuniao,
    tipoAssembleia: "Ordinária",
    convocatoriaData: iso,
    presidente: "",
    secretario: "",
    presentes: "",
  };
}

export function emptyConteudo(dataReuniao: Date): AtaConteudo {
  return {
    version: 1,
    cabecalho: defaultCabecalho(dataReuniao),
    pontos: [],
  };
}

function newPontoId(): string {
  return crypto.randomUUID();
}

export function normalizePonto(raw: Partial<AtaPonto>, index: number): AtaPonto {
  const titulo = String(raw.titulo ?? `Ponto ${index + 1}`).trim() || `Ponto ${index + 1}`;
  const discussao = String(raw.discussao ?? "").trim();
  const deliberacao = String(raw.deliberacao ?? "").trim();
  const texto = String(raw.texto ?? "").trim();

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newPontoId(),
    titulo,
    texto,
    discussao,
    deliberacao,
    votos: normalizeVotos(raw.votos),
  };
}

function normalizeVotos(raw: Partial<AtaVotosPonto> | undefined): AtaVotosPonto {
  const favor = Number(raw?.favor ?? 0);
  const contra = Number(raw?.contra ?? 0);
  const abstencao = Number(raw?.abstencao ?? 0);
  return {
    favor: Number.isFinite(favor) ? Math.max(0, Math.round(favor)) : 0,
    contra: Number.isFinite(contra) ? Math.max(0, Math.round(contra)) : 0,
    abstencao: Number.isFinite(abstencao) ? Math.max(0, Math.round(abstencao)) : 0,
    source: raw?.source === "ata_votes" ? "ata_votes" : "manual",
    autoFilledAt: raw?.autoFilledAt ?? null,
    ataVotesSnapshotAt: raw?.ataVotesSnapshotAt ?? null,
  };
}

export function normalizeConteudo(raw: unknown, dataReuniao: Date): AtaConteudo {
  if (!raw || typeof raw !== "object") return emptyConteudo(dataReuniao);

  const obj = raw as Partial<AtaConteudo>;
  const base = defaultCabecalho(dataReuniao);
  const incoming = obj.cabecalho && typeof obj.cabecalho === "object" ? obj.cabecalho : {};
  const cab: AtaCabecalho = { ...base };
  for (const key of Object.keys(base) as (keyof AtaCabecalho)[]) {
    const v = (incoming as Record<string, unknown>)[key];
    if (v == null) continue;
    cab[key] = typeof v === "string" ? v : String(v);
  }

  const pontos = Array.isArray(obj.pontos)
    ? obj.pontos.map((p, i) => normalizePonto(p as Partial<AtaPonto>, i))
    : [];

  return { version: 1, cabecalho: cab, pontos };
}

export function parseConteudoJson(
  raw: string | object | null | undefined,
  dataReuniao: Date,
): AtaConteudo | null {
  if (raw && typeof raw === "object") {
    return normalizeConteudo(raw, dataReuniao);
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return normalizeConteudo(JSON.parse(raw), dataReuniao);
  } catch {
    return null;
  }
}

export function serializeConteudo(conteudo: AtaConteudo): string {
  return JSON.stringify(normalizeConteudo(conteudo, new Date(conteudo.cabecalho.dataReuniao)));
}

export function resolveConteudo(
  conteudoJson: string | object | null | undefined,
  ataTexto: string | null | undefined,
  dataReuniao: Date,
): AtaConteudo {
  const parsed = parseConteudoJson(conteudoJson, dataReuniao);
  if (parsed) return parsed;
  return conteudoFromLegacyMarkdown(String(ataTexto ?? ""), dataReuniao);
}

export function conteudoFromLegacyMarkdown(ataTexto: string, dataReuniao: Date): AtaConteudo {
  const conteudo = emptyConteudo(dataReuniao);
  const text = ataTexto.trim();
  if (!text) return conteudo;

  conteudo.pontos = [{
    id: newPontoId(),
    titulo: "Conteúdo importado",
    texto: text,
    discussao: "",
    deliberacao: "",
    votos: defaultVotos(),
  }];
  return conteudo;
}

/** Texto integral da ata no formato legal (também usado como ataTexto persistido). */
export function conteudoToMarkdown(conteudo: AtaConteudo): string {
  return conteudoToTextoFormal(conteudo);
}

export { conteudoToTextoFormal } from "./ata-formato";
