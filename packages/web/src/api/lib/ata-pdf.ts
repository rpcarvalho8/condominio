import fs from "node:fs";
import path from "node:path";
import { htmlToPdf } from "./html-to-pdf";

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
  resumoDeliberacoes: string | null;
}): Promise<string> {
  const dataFormatada = new Date(ata.dataReuniao).toLocaleDateString("pt-PT", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const resumoHtml = ata.resumoDeliberacoes
    ? `<div class="section"><h2>Resumo de Deliberações</h2><div class="content">${escapeHtml(ata.resumoDeliberacoes).replace(/\n/g, "<br>")}</div></div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px 50px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .date { text-align: center; color: #555; font-size: 13px; margin-bottom: 30px; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 10px; }
  .content { font-size: 13px; white-space: pre-wrap; }
  .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #999; }
</style>
</head>
<body>
  <h1>${escapeHtml(ata.titulo)}</h1>
  <p class="date">${escapeHtml(dataFormatada)}</p>
  ${resumoHtml}
  <div class="section">
    <h2>Ata</h2>
    <div class="content">${escapeHtml(ata.ataTexto).replace(/\n/g, "<br>")}</div>
  </div>
  <div class="footer">Documento gerado automaticamente · Gestão Condomínio</div>
</body>
</html>`;

  const filename = `ata_${ata.id.slice(0, 8)}_${Date.now()}.pdf`;
  const absolutePath = path.join(ATAS_PDF_DIR, filename);
  await htmlToPdf(html, absolutePath);

  return `/api/atas/pdf/${filename}`;
}
