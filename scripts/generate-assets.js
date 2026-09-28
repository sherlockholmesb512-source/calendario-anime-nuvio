'use strict';

/**
 * Genera logo.png e background.png senza dipendenze esterne.
 *   node scripts/generate-assets.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG encoder

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array di w*h*4 */
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0; // filtro "none"
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(
      raw,
      y * (w * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ disegno

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeCanvas(w, h) {
  const data = new Uint8Array(w * h * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const na = a / 255;
    data[i] = Math.round(lerp(data[i], r, na));
    data[i + 1] = Math.round(lerp(data[i + 1], g, na));
    data[i + 2] = Math.round(lerp(data[i + 2], b, na));
    data[i + 3] = Math.max(data[i + 3], a);
  };
  return { data, set, w, h };
}

const putPx = (cv, x, y, r, g, b, a = 255) => {
  x |= 0;
  y |= 0;
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.data[i] = r;
  cv.data[i + 1] = g;
  cv.data[i + 2] = b;
  cv.data[i + 3] = a;
};

/** Rettangolo con angoli arrotondati + antialiasing 3x3. */
function roundRect(cv, x0, y0, w, h, radius, [r, g, b], a = 255) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y += 1) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
          const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= radius * radius) hits += 1;
        }
      }
      if (hits) putPx(cv, x, y, r, g, b, Math.round((a * hits) / 9));
    }
  }
}

function triangle(cv, ax, ay, bx, by, cx, cy, [r, g, b]) {
  const minX = Math.floor(Math.min(ax, bx, cx)) - 1;
  const maxX = Math.ceil(Math.max(ax, bx, cx)) + 1;
  const minY = Math.floor(Math.min(ay, by, cy)) - 1;
  const maxY = Math.ceil(Math.max(ay, by, cy)) + 1;
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          const d1 = sign(px, py, ax, ay, bx, by);
          const d2 = sign(px, py, bx, by, cx, cy);
          const d3 = sign(px, py, cx, cy, ax, ay);
          const neg = d1 < 0 || d2 < 0 || d3 < 0;
          const pos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(neg && pos)) hits += 1;
        }
      }
      if (hits) putPx(cv, x, y, r, g, b, Math.round((255 * hits) / 9));
    }
  }
}

const BRAND_A = [79, 70, 229]; // indigo-600
const BRAND_B = [147, 51, 234]; // violet-600
const BRAND_C = [236, 72, 153]; // pink-500

/** Sfondo a gradiente diagonale. */
function fillGradient(cv, c0, c1) {
  for (let y = 0; y < cv.h; y += 1) {
    for (let x = 0; x < cv.w; x += 1) {
      const t = clamp01((x / cv.w) * 0.55 + (y / cv.h) * 0.45);
      putPx(cv, x, y, lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t), 255);
    }
  }
}

// -------------------------------------------------------------------- logo

function buildLogo(size = 512) {
  const cv = makeCanvas(size, size);
  fillGradient(cv, BRAND_A, BRAND_B);

  // Anello esterno arrotondato
  const m = size * 0.075;
  roundRect(cv, m, m, size - m * 2, size - m * 2, size * 0.22, [255, 255, 255], 26);

  // Corpo del calendario
  const cx0 = size * 0.2;
  const cy0 = size * 0.24;
  const cw = size * 0.6;
  const ch = size * 0.54;
  roundRect(cv, cx0, cy0, cw, ch, size * 0.09, [255, 255, 255], 255);

  // Barra superiore colorata
  roundRect(cv, cx0, cy0, cw, ch * 0.24, size * 0.09, BRAND_C, 255);
  // Riallinea la parte inferiore della barra per un bordo inferiore netto
  for (let y = Math.floor(cy0 + ch * 0.17); y < Math.floor(cy0 + ch * 0.24); y += 1) {
    for (let x = Math.floor(cx0 + size * 0.02); x < Math.floor(cx0 + cw - size * 0.02); x += 1) {
      putPx(cv, x, y, BRAND_C[0], BRAND_C[1], BRAND_C[2], 255);
    }
  }

  // Anelli del calendario
  const ringW = size * 0.045;
  for (const rx of [size * 0.35, size * 0.65]) {
    roundRect(cv, rx - ringW / 2, cy0 - ringW * 0.9, ringW, ch * 0.2, ringW / 2, [255, 255, 255], 255);
  }

  // Griglia di "giorni": 3 colonne x 2 righe, con l'ultima evidenziata
  const gx0 = cx0 + cw * 0.16;
  const gy0 = cy0 + ch * 0.42;
  const cell = cw * 0.2;
  const gap = cw * 0.08;
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const x = gx0 + c * (cell + gap);
      const y = gy0 + r * (cell * 0.72 + gap * 0.6);
      const hot = r === 1 && c === 2;
      roundRect(cv, x, y, cell, cell * 0.72, cell * 0.18, hot ? BRAND_C : [203, 213, 225], 255);
    }
  }

  // Triangolo "play" in basso a destra
  const pr = size * 0.135;
  const pcx = size * 0.735;
  const pcy = size * 0.735;
  const ring = pr * 1.42;
  // alone
  for (let y = Math.floor(pcy - ring); y <= Math.ceil(pcy + ring); y += 1) {
    for (let x = Math.floor(pcx - ring); x <= Math.ceil(pcx + ring); x += 1) {
      const d = Math.hypot(x + 0.5 - pcx, y + 0.5 - pcy);
      const t = clamp01((ring - d) / (ring * 0.35));
      if (t > 0) putPx(cv, x, y, 255, 255, 255, Math.round(150 * t));
    }
  }
  roundRect(cv, pcx - ring, pcy - ring, ring * 2, ring * 2, ring, BRAND_A, 255);
  triangle(
    cv,
    pcx - pr * 0.5, pcy - pr,
    pcx - pr * 0.5, pcy + pr,
    pcx + pr * 0.85, pcy,
    [255, 255, 255],
  );

  return encodePng(cv.data, cv.w, cv.h);
}

// -------------------------------------------------------------- background

function buildBackground(w = 1920, h = 1080) {
  const cv = makeCanvas(w, h);
  fillGradient(cv, [30, 27, 75], [76, 29, 149]);

  // Alone luminoso in alto a destra
  const gx = w * 0.78;
  const gy = h * 0.18;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.hypot((x - gx) / (w * 0.55), (y - gy) / (h * 0.75));
      const t = clamp01(1 - d) ** 2;
      if (t > 0.002) {
        const i = (y * w + x) * 4;
        cv.data[i] = Math.round(lerp(cv.data[i], BRAND_C[0], t * 0.35));
        cv.data[i + 1] = Math.round(lerp(cv.data[i + 1], BRAND_C[1], t * 0.35));
        cv.data[i + 2] = Math.round(lerp(cv.data[i + 2], BRAND_C[2], t * 0.35));
      }
    }
  }

  // Reticolo di pallini, stile "calendario"
  const step = 64;
  for (let y = step; y < h; y += step) {
    for (let x = step; x < w; x += step) {
      const a = 26 + Math.round(20 * Math.sin((x / w) * Math.PI));
      const r = 2.2;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const d = Math.hypot(dx, dy);
          if (d <= r) {
            const al = Math.round(a * (1 - d / (r + 0.6)));
            const i = ((y + dy) * w + (x + dx)) * 4;
            if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) {
              cv.data[i] = 255;
              cv.data[i + 1] = 255;
              cv.data[i + 2] = 255;
              cv.data[i + 3] = Math.max(cv.data[i + 3], al);
            }
          }
        }
      }
    }
  }

  // Fasce "orario" in basso a sinistra, come un calendario
  for (let i = 0; i < 5; i += 1) {
    const bw = w * (0.06 + i * 0.028);
    roundRect(cv, w * 0.08, h * (0.62 + i * 0.06), bw, h * 0.026, h * 0.013, [255, 255, 255], 46 - i * 6);
  }

  return encodePng(cv.data, cv.w, cv.h);
}

function main() {
  const out = path.join(__dirname, '..', 'public');
  fs.mkdirSync(out, { recursive: true });

  // Il logo ufficiale e' un'immagine fornita a mano: non lo sovrascriviamo.
  const logo = path.join(out, 'logo.png');
  if (fs.existsSync(logo)) {
    console.log('public/logo.png gia\' presente, lasciato intatto');
  } else {
    fs.writeFileSync(logo, buildLogo(512));
    console.log('generato public/logo.png');
  }

  fs.writeFileSync(path.join(out, 'background.png'), buildBackground(1920, 1080));
  console.log('generato public/background.png');
}

main();
