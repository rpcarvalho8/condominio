/**
 * Instala o Chromium do Puppeteer no cache local (PDFs no servidor).
 * Corre no `postinstall` da raiz do monorepo (Bun não executa o postinstall
 * dos workspaces por omissão) e também no de `@template/web`.
 * `bun install` na raiz chega — não é preciso um segundo comando.
 *
 * Idempotente: se o executável da versão actual já existir, não volta a descarregar
 * (~170–300 MB).
 *
 * CI: defina `PUPPETEER_SKIP_DOWNLOAD=1` ou `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1`
 * para saltar o download. Em Linux de produção ainda são precisas libs do SO
 * (ver comentário no final deste ficheiro).
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function envTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

if (
  envTruthy("PUPPETEER_SKIP_DOWNLOAD") ||
  envTruthy("PUPPETEER_SKIP_CHROMIUM_DOWNLOAD")
) {
  console.log(
    "[pdf] A saltar o Chromium (PUPPETEER_SKIP_DOWNLOAD) — use só em CI.",
  );
  process.exit(0);
}

async function existingChromePath(): Promise<string | undefined> {
  try {
    const puppeteer = await import("puppeteer");
    const executablePath = await puppeteer.default.executablePath();
    if (executablePath && existsSync(executablePath)) return executablePath;
  } catch {
    // pacote ainda não resolvível ou cache vazio
  }
  return undefined;
}

const existing = await existingChromePath();
if (existing) {
  console.log(`[pdf] Chromium já está no cache: ${existing}`);
  process.exit(0);
}

console.log("[pdf] A instalar Chromium para PDFs (~170–300 MB)...");
const result = spawnSync(
  "bunx",
  ["puppeteer", "browsers", "install", "chrome"],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  console.error(
    "[pdf] Falha ao lançar a instalação do Chromium:",
    result.error.message,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);

/**
 * Libs do SO (Linux / produção) — não são o browser, são dependências nativas:
 *   sudo apt-get install -y ca-certificates fonts-liberation libasound2t64 \
 *     libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
 *     libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2
 */
