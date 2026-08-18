import puppeteer from "puppeteer";
import fs from "node:fs";

export type HtmlToPdfOptions = {
  landscape?: boolean;
};

/**
 * Server-side HTML → PDF. Uses Puppeteer's bundled Chromium — not the user's
 * Opera/Chrome, and not a required system `google-chrome-stable` install.
 *
 * Override with PUPPETEER_EXECUTABLE_PATH if needed.
 */
async function resolveExecutablePath(): Promise<string | undefined> {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  try {
    const bundled = await puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Cache vazio — o postinstall do `bun install` deveria ter instalado o Chrome
  }

  const fallbacks = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ];
  return fallbacks.find((p) => fs.existsSync(p));
}

export async function htmlToPdf(
  html: string,
  outPath: string,
  options: HtmlToPdfOptions = {},
): Promise<void> {
  const executablePath = await resolveExecutablePath();
  if (!executablePath) {
    throw new Error(
      "Nenhum Chromium encontrado para gerar PDF. Deveria ter sido instalado no `bun install`. Volte a correr `bun install` (sem PUPPETEER_SKIP_DOWNLOAD) ou defina PUPPETEER_EXECUTABLE_PATH.",
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      landscape: options.landscape ?? false,
    });
  } finally {
    await browser.close();
  }
}
