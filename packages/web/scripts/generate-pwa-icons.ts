/**
 * Gera ícones PWA Sevilla (#D0021B + branco). Sem dependências.
 * bun run scripts/generate-pwa-icons.ts
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RED: [number, number, number] = [0xd0, 0x02, 0x1b];
const WHITE: [number, number, number] = [255, 255, 255];

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * stride + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** "L" geométrico centrado — marca mínima LUMEN. */
function drawL(
  size: number,
  padRatio: number,
): (x: number, y: number) => [number, number, number] {
  const pad = size * padRatio;
  const inner = size - pad * 2;
  const stroke = inner * 0.22;
  const left = pad + inner * 0.22;
  const top = pad + inner * 0.18;
  const right = pad + inner * 0.78;
  const bottom = pad + inner * 0.82;
  return (x, y) => {
    const inStem = x >= left && x <= left + stroke && y >= top && y <= bottom;
    const inBase = x >= left && x <= right && y >= bottom - stroke && y <= bottom;
    return inStem || inBase ? WHITE : RED;
  };
}

const outDir = path.resolve(import.meta.dir, "../public/icons");
mkdirSync(outDir, { recursive: true });

writeFileSync(path.join(outDir, "icon-192.png"), png(192, 192, drawL(192, 0.12)));
writeFileSync(path.join(outDir, "icon-512.png"), png(512, 512, drawL(512, 0.12)));
writeFileSync(path.join(outDir, "icon-192-maskable.png"), png(192, 192, drawL(192, 0.22)));
writeFileSync(path.join(outDir, "icon-512-maskable.png"), png(512, 512, drawL(512, 0.22)));
writeFileSync(path.resolve(import.meta.dir, "../public/apple-touch-icon.png"), png(180, 180, drawL(180, 0.14)));

console.log("PWA icons written to", outDir);
