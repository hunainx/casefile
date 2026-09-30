import { deflateSync, crc32 } from "node:zlib";
import type { Rng } from "./prng.js";

/**
 * Pixels for the fake corpus: a 5x7 bitmap font (so a "scanned" page carries real text as an
 * image, which an OCR engine can read and a text-layer parser cannot) and a minimal PNG writer
 * with a tEXt chunk for the corpus marker. Built on node:zlib only.
 */

// Rows top to bottom, bit 4 = leftmost pixel.
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c], ",": [0, 0, 0, 0, 0x0c, 0x04, 0x08], ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "-": [0, 0, 0, 0x1f, 0, 0, 0], "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "/": [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0], "'": [0x0c, 0x04, 0x08, 0, 0, 0, 0], "@": [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0f],
  "&": [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d], "$": [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04], " ": [0, 0, 0, 0, 0, 0, 0],
};

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, 0 = black, 255 = white. */
  pixels: Buffer;
}

/** Wraps text into lines of at most `width` characters. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A "scanned" A4 page at 150 dpi: off-white paper, the text in the bitmap font, a slight
 * random offset and dust specks, so no two scans of the same text are the same bytes.
 */
export function scannedPage(rng: Rng, text: string): GrayImage {
  const width = 1240;
  const height = 1754;
  const scale = 3;
  const margin = 90;
  const lineHeight = 12 * scale;
  const perLine = Math.floor((width - 2 * margin) / (6 * scale));
  const pixels = Buffer.alloc(width * height, 246);
  // Dust.
  for (let i = 0; i < 1500; i++) pixels[rng.int(0, width * height - 1)] = rng.int(80, 200);
  const dx = rng.int(-6, 6);
  const dy = rng.int(-6, 6);
  const lines = wrap(text.toUpperCase(), perLine).slice(0, Math.floor((height - 2 * margin) / lineHeight));
  lines.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const glyph = GLYPHS[line[col]!] ?? GLYPHS[" "]!;
      const ox = margin + dx + col * 6 * scale;
      const oy = margin + dy + row * lineHeight;
      for (let gy = 0; gy < 7; gy++) {
        const bits = glyph[gy]!;
        for (let gx = 0; gx < 5; gx++) {
          if (!(bits & (0x10 >> gx))) continue;
          for (let sy = 0; sy < scale; sy++) {
            const y = oy + gy * scale + sy;
            const rowStart = y * width;
            for (let sx = 0; sx < scale; sx++) pixels[rowStart + ox + gx * scale + sx] = 20;
          }
        }
      }
    }
  });
  return { width, height, pixels };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

/** Encodes a PNG (8-bit gray or RGB), with the marker as a tEXt chunk. */
export function encodePng(width: number, height: number, channels: 1 | 3, pixels: Buffer, marker: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`Comment\0${marker}`, "latin1")),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A "photo": smooth colour gradients plus grain, so it compresses about as badly as a real
 * camera image. Sized by the caller.
 */
export function photo(rng: Rng, width: number, height: number, marker: string): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  const [r0, g0, b0] = [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];
  const [r1, g1, b1] = [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];
  const grain = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y++) {
    rng.fill(grain);
    const t = y / height;
    for (let x = 0; x < width; x++) {
      const s = x / width;
      const i = (y * width + x) * 3;
      const g = grain[x * 3]! % 48;
      pixels[i] = Math.min(255, (r0 * (1 - t) + r1 * s) / 1.5 + g);
      pixels[i + 1] = Math.min(255, (g0 * (1 - s) + g1 * t) / 1.5 + (grain[x * 3 + 1]! % 48));
      pixels[i + 2] = Math.min(255, (b0 * t + b1 * (1 - s)) / 1.5 + (grain[x * 3 + 2]! % 48));
    }
  }
  return encodePng(width, height, 3, pixels, marker);
}
