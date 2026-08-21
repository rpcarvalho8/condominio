import fs from "node:fs";
import path from "node:path";
import { htmlToPdf } from "./html-to-pdf";
import { resolveConteudo, conteudoToTextoFormal } from "./ata-conteudo";

const ATAS_PDF_DIR = path.join(process.cwd(), "data", "atas");
fs.mkdirSync(ATAS_PDF_DIR, { recursive: true });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function gerarAtaPdf(ata: {
  id: string;
  titulo: string;
  dataReuniao: Date | string;
  ataTexto: string;
  conteudoJson?: string | null;
  resumoDeliberacoes: string | null;
}): Promise<string> {
  const conteudo = resolveConteudo(ata.conteudoJson, ata.ataTexto, new Date(ata.dataReuniao));
  const textoFormal = conteudoToTextoFormal(conteudo);

  const resumoHtml = ata.resumoDeliberacoes
    ? `<div class="anexo"><p class="anexo-titulo">Resumo de deliberações</p><div class="corpo">${escapeHtml(ata.resumoDeliberacoes).replace(/\n/g, "<br>")}</div></div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 2.5cm 2cm; }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
    text-align: justify;
    margin: 0;
    padding: 0;
  }
  h1 {
    font-size: 14pt;
    text-align: center;
    font-weight: bold;
    text-transform: uppercase;
    margin: 0 0 24pt;
    letter-spacing: 0.5px;
  }
  .corpo {
    white-space: pre-wrap;
    text-align: justify;
  }
  .anexo {
    margin-top: 24pt;
    padding-top: 12pt;
    border-top: 1px solid #ccc;
  }
  .anexo-titulo {
    font-weight: bold;
    font-size: 11pt;
    margin-bottom: 8pt;
  }
  .footer {
    margin-top: 36pt;
    text-align: center;
    font-size: 9pt;
    color: #666;
  }
</style>
</head>
<body>
  <h1>${escapeHtml(ata.titulo)}</h1>
  <div class="corpo">${escapeHtml(textoFormal).replace(/\n/g, "<br>")}</div>
  ${resumoHtml}
  <div class="footer">Documento gerado automaticamente · Gestão Condomínio</div>
</body>
</html>`;

  const filename = `ata_${ata.id.slice(0, 8)}_${Date.now()}.pdf`;
  const absolutePath = path.join(ATAS_PDF_DIR, filename);
  await htmlToPdf(html, absolutePath);

  return `/api/atas/pdf/${filename}`;
}
