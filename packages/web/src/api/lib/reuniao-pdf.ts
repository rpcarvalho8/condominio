import fs from "node:fs";
import path from "node:path";
import { htmlToPdf } from "./html-to-pdf";
import { CONDOMINIO } from "./condominio";

const REUNIOES_PDF_DIR = path.join(process.cwd(), "data", "reunioes-pdf");
fs.mkdirSync(REUNIOES_PDF_DIR, { recursive: true });

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderList(items: string[]): string {
  const filtered = items.filter(Boolean);
  if (filtered.length === 0) return "<p class='muted'>—</p>";
  return `<ul>${filtered.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function renderActionTable(actions: Array<{ acao?: string; decisao?: string; responsavel: string; prazo: string }>): string {
  if (actions.length === 0) return "<p class='muted'>Sem ações registadas.</p>";
  return `<table class="action-table">
    <thead><tr><th>Ação</th><th>Responsável</th><th>Prazo</th></tr></thead>
    <tbody>${actions.map(a => `<tr><td>${esc(a.acao || a.decisao || "—")}</td><td>${esc(a.responsavel || "—")}</td><td>${esc(a.prazo || "—")}</td></tr>`).join("")}</tbody>
  </table>`;
}

function renderInternaHtml(content: any, titulo: string, data: string): string {
  const sections: string[] = [];

  if (content.abertura) sections.push(`<div class="section"><h2>Abertura</h2><p>${esc(content.abertura)}</p></div>`);
  if (content.presencas?.length > 0) sections.push(`<div class="section"><h2>Presenças</h2><p>${content.presencas.map(esc).join(", ")}</p></div>`);
  if (content.aprovacaoAtaAnterior) sections.push(`<div class="section"><h2>Aprovação da ata/reunião anterior</h2><p>${esc(content.aprovacaoAtaAnterior)}</p></div>`);
  if (content.objetivosReuniao) sections.push(`<div class="section"><h2>Objetivos da reunião</h2><p>${esc(content.objetivosReuniao)}</p></div>`);

  if (content.situacaoFinanceira) {
    const sf = content.situacaoFinanceira;
    const rows = [
      sf.contasCondominio && `<p><strong>Contas do condomínio:</strong> ${esc(sf.contasCondominio)}</p>`,
      sf.pagamentosAtraso && `<p><strong>Pagamentos em atraso:</strong> ${esc(sf.pagamentosAtraso)}</p>`,
      sf.despesas && `<p><strong>Despesas:</strong> ${esc(sf.despesas)}</p>`,
      sf.orcamento && `<p><strong>Orçamento:</strong> ${esc(sf.orcamento)}</p>`,
    ].filter(Boolean).join("");
    if (rows) sections.push(`<div class="section"><h2>Situação financeira</h2>${rows}</div>`);
  }

  if (content.manutencaoProblemas) {
    const mp = content.manutencaoProblemas;
    const parts: string[] = [];
    if (mp.problemasIdentificados?.length > 0) parts.push(`<p><strong>Problemas identificados:</strong></p>${renderList(mp.problemasIdentificados)}`);
    if (mp.obrasNecessarias?.length > 0) parts.push(`<p><strong>Obras/intervenções necessárias:</strong></p>${renderList(mp.obrasNecessarias)}`);
    if (mp.situacoesUrgentes?.length > 0) parts.push(`<p><strong>Situações urgentes:</strong></p>${renderList(mp.situacoesUrgentes)}`);
    if (mp.reclamacoesCondominos?.length > 0) parts.push(`<p><strong>Reclamações de condóminos:</strong></p>${renderList(mp.reclamacoesCondominos)}`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Manutenção e problemas do condomínio</h2>${parts.join("")}</div>`);
  }

  if (content.fornecedores) {
    const f = content.fornecedores;
    const parts: string[] = [];
    if (f.avaliacaoServicos) parts.push(`<p><strong>Avaliação dos serviços:</strong> ${esc(f.avaliacaoServicos)}</p>`);
    if (f.contratosExistentes) parts.push(`<p><strong>Contratos existentes:</strong> ${esc(f.contratosExistentes)}</p>`);
    if (f.problemas?.length > 0) parts.push(`<p><strong>Problemas com fornecedores:</strong></p>${renderList(f.problemas)}`);
    if (f.novosOrcamentos) parts.push(`<p><strong>Necessidade de novos orçamentos:</strong> ${esc(f.novosOrcamentos)}</p>`);
    if (f.renovacoesRescisoes) parts.push(`<p><strong>Renovações/rescisões:</strong> ${esc(f.renovacoesRescisoes)}</p>`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Fornecedores</h2>${parts.join("")}</div>`);
  }

  if (content.decisoesAdministracao?.length > 0) {
    sections.push(`<div class="section"><h2>Decisões da administração</h2>${renderActionTable(content.decisoesAdministracao)}</div>`);
  }

  if (content.preparacaoReunioesFornecedores) {
    const pr = content.preparacaoReunioesFornecedores;
    const parts: string[] = [];
    if (pr.questionar?.length > 0) parts.push(`<p><strong>O que queremos questionar:</strong></p>${renderList(pr.questionar)}`);
    if (pr.negociar?.length > 0) parts.push(`<p><strong>O que queremos negociar:</strong></p>${renderList(pr.negociar)}`);
    if (pr.documentacaoNecessaria) parts.push(`<p><strong>Documentação necessária:</strong> ${esc(pr.documentacaoNecessaria)}</p>`);
    if (pr.objetivos?.length > 0) parts.push(`<p><strong>Objetivos a atingir:</strong></p>${renderList(pr.objetivos)}`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Preparação das reuniões com fornecedores</h2>${parts.join("")}</div>`);
  }

  if (content.outrosAssuntos?.length > 0) sections.push(`<div class="section"><h2>Outros assuntos</h2>${renderList(content.outrosAssuntos)}</div>`);
  if (content.conclusoesProximasAcoes?.length > 0) sections.push(`<div class="section"><h2>Conclusões e próximas ações</h2>${renderList(content.conclusoesProximasAcoes)}</div>`);

  return buildFullHtml(`REUNIÃO DA ADMINISTRAÇÃO DO CONDOMÍNIO`, titulo, data, sections.join(""));
}

function renderFornecedorHtml(content: any, titulo: string, data: string): string {
  const nome = content.fornecedorNome || "N/I";
  const sections: string[] = [];

  if (content.apresentacao) {
    const a = content.apresentacao;
    const parts: string[] = [];
    if (a.participantes?.length > 0) parts.push(`<p><strong>Participantes:</strong> ${a.participantes.map(esc).join(", ")}</p>`);
    if (a.servicoPrestado) parts.push(`<p><strong>Serviço prestado:</strong> ${esc(a.servicoPrestado)}</p>`);
    if (a.objetivoReuniao) parts.push(`<p><strong>Objetivo da reunião:</strong> ${esc(a.objetivoReuniao)}</p>`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Apresentação</h2>${parts.join("")}</div>`);
  }

  if (content.balancoServico) {
    const b = content.balancoServico;
    const parts: string[] = [];
    if (b.funciona?.length > 0) parts.push(`<p><strong>O que está a funcionar:</strong></p>${renderList(b.funciona)}`);
    if (b.naoFunciona?.length > 0) parts.push(`<p><strong>O que não está a funcionar:</strong></p>${renderList(b.naoFunciona)}`);
    if (b.ocorrencias?.length > 0) parts.push(`<p><strong>Ocorrências registadas:</strong></p>${renderList(b.ocorrencias)}`);
    if (b.cumprimentoContrato) parts.push(`<p><strong>Cumprimento do contrato:</strong> ${esc(b.cumprimentoContrato)}</p>`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Balanço do serviço</h2>${parts.join("")}</div>`);
  }

  if (content.problemasAdministracao?.length > 0) {
    sections.push(`<div class="section"><h2>Problemas identificados pela administração</h2>${renderList(content.problemasAdministracao)}</div>`);
  }

  if (content.posicaoFornecedor) {
    const p = content.posicaoFornecedor;
    const parts: string[] = [];
    if (p.explicacao) parts.push(`<p><strong>Explicação das situações:</strong> ${esc(p.explicacao)}</p>`);
    if (p.causas) parts.push(`<p><strong>Causas:</strong> ${esc(p.causas)}</p>`);
    if (p.solucoesPropostas?.length > 0) parts.push(`<p><strong>Soluções propostas:</strong></p>${renderList(p.solucoesPropostas)}`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Posição do fornecedor</h2>${parts.join("")}</div>`);
  }

  if (content.necessidadesCondominio) {
    const n = content.necessidadesCondominio;
    const parts: string[] = [];
    if (n.melhorias?.length > 0) parts.push(`<p><strong>Melhorias pretendidas:</strong></p>${renderList(n.melhorias)}`);
    if (n.alteracoesServico?.length > 0) parts.push(`<p><strong>Alterações ao serviço:</strong></p>${renderList(n.alteracoesServico)}`);
    if (n.novasNecessidades?.length > 0) parts.push(`<p><strong>Novas necessidades:</strong></p>${renderList(n.novasNecessidades)}`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Necessidades do condomínio</h2>${parts.join("")}</div>`);
  }

  if (content.questoesFinanceiras) {
    const q = content.questoesFinanceiras;
    const parts: string[] = [];
    if (q.precos) parts.push(`<p><strong>Preços:</strong> ${esc(q.precos)}</p>`);
    if (q.orcamentos) parts.push(`<p><strong>Orçamentos:</strong> ${esc(q.orcamentos)}</p>`);
    if (q.contrato) parts.push(`<p><strong>Contrato:</strong> ${esc(q.contrato)}</p>`);
    if (q.condicoes) parts.push(`<p><strong>Condições:</strong> ${esc(q.condicoes)}</p>`);
    if (q.prazos) parts.push(`<p><strong>Prazos:</strong> ${esc(q.prazos)}</p>`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Questões financeiras/contratuais</h2>${parts.join("")}</div>`);
  }

  if (content.planoAcao?.length > 0) {
    sections.push(`<div class="section"><h2>Plano de ação acordado</h2>${renderActionTable(content.planoAcao)}</div>`);
  }

  if (content.conclusao) {
    const c = content.conclusao;
    const parts: string[] = [];
    if (c.decisoesTomadas?.length > 0) parts.push(`<p><strong>Decisões tomadas:</strong></p>${renderList(c.decisoesTomadas)}`);
    if (c.pontosPendentes?.length > 0) parts.push(`<p><strong>Pontos que ficaram pendentes:</strong></p>${renderList(c.pontosPendentes)}`);
    if (c.dataAcompanhamento) parts.push(`<p><strong>Data de acompanhamento:</strong> ${esc(c.dataAcompanhamento)}</p>`);
    if (parts.length > 0) sections.push(`<div class="section"><h2>Conclusão</h2>${parts.join("")}</div>`);
  }

  return buildFullHtml(`REUNIÃO COM FORNECEDOR — ${esc(nome)}`, titulo, data, sections.join(""));
}

function buildFullHtml(header: string, titulo: string, data: string, body: string): string {
  const dataFormatada = new Date(data).toLocaleDateString("pt-PT", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 2cm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 0; padding: 0; }
  h1 { font-size: 14pt; text-align: center; font-weight: bold; text-transform: uppercase; margin: 0 0 4pt; letter-spacing: 0.5px; }
  .subtitle { text-align: center; font-size: 11pt; margin-bottom: 4pt; color: #333; }
  .date { text-align: center; color: #555; font-size: 10pt; margin-bottom: 20pt; }
  .meta { text-align: center; font-size: 9pt; color: #666; margin-bottom: 20pt; }
  .section { margin-bottom: 16pt; }
  .section h2 { font-size: 11pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; color: #222; border-bottom: 1px solid #ccc; padding-bottom: 3pt; margin: 0 0 8pt; }
  p { margin: 4pt 0; font-size: 10.5pt; }
  ul { margin: 4pt 0 8pt 16pt; padding: 0; }
  li { font-size: 10.5pt; margin-bottom: 3pt; }
  strong { font-weight: 600; }
  .muted { color: #777; font-style: italic; }
  .action-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 8pt 0; }
  .action-table th { background: #f5f5f5; font-weight: 600; text-align: left; padding: 5pt 8pt; border: 1px solid #ddd; }
  .action-table td { padding: 5pt 8pt; border: 1px solid #ddd; }
  .footer { margin-top: 30pt; text-align: center; font-size: 8pt; color: #999; border-top: 1px solid #eee; padding-top: 8pt; }
</style>
</head>
<body>
  <h1>${header}</h1>
  <p class="subtitle">${esc(titulo)}</p>
  <p class="date">${esc(dataFormatada)}</p>
  <p class="meta">${esc(CONDOMINIO.nome)} · ${esc(CONDOMINIO.morada)}</p>
  ${body}
  <div class="footer">Documento gerado automaticamente · Gestão Condomínio</div>
</body>
</html>`;
}

export async function gerarReuniaoPdf(reuniao: {
  id: string;
  titulo: string;
  data: Date | string;
  tipo: string;
  resumoJson: string | null;
  resumo: string | null;
}): Promise<string> {
  const dataStr = new Date(reuniao.data).toISOString().slice(0, 10);
  let html: string;

  if (reuniao.resumoJson) {
    try {
      const content = JSON.parse(reuniao.resumoJson);
      if (content.tipo === "fornecedor") {
        html = renderFornecedorHtml(content, reuniao.titulo, dataStr);
      } else {
        html = renderInternaHtml(content, reuniao.titulo, dataStr);
      }
    } catch {
      html = buildFullHtml("REUNIÃO", reuniao.titulo, dataStr,
        `<div class="section"><h2>Resumo</h2><p>${esc(reuniao.resumo || "Sem conteúdo.")}</p></div>`);
    }
  } else {
    html = buildFullHtml("REUNIÃO", reuniao.titulo, dataStr,
      `<div class="section"><h2>Resumo</h2><p>${esc(reuniao.resumo || "Sem conteúdo.").replace(/\n/g, "<br>")}</p></div>`);
  }

  const filename = `reuniao_${reuniao.id.slice(0, 8)}_${Date.now()}.pdf`;
  const absolutePath = path.join(REUNIOES_PDF_DIR, filename);
  await htmlToPdf(html, absolutePath);

  return `/api/reunioes/pdf/${filename}`;
}
