/**
 * 生成 SimpleWork 应用图标（纯 Node，零依赖）：256 设计稿 -> 多尺寸 PNG -> ICO。
 * 用法：node scripts/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', '..', 'desktop', 'build');
fs.mkdirSync(outDir, { recursive: true });

const SS = 4; // 超采样倍数（抗锯齿）

/* ----------------------------- PNG 编码 ----------------------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------- ICO ----------------------------- */

function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  const blobs = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(img.png);
    offset += img.png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ----------------------------- 绘制 ----------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 圆角矩形 SDF 覆盖率：内部 1、外部 0、边缘 1px 渐变 */
function rrCoverage(x, y, rx, ry, rw, rh, radius) {
  const cx = Math.min(Math.max(x, rx + radius), rx + rw - radius);
  const cy = Math.min(Math.max(y, ry + radius), ry + rh - radius);
  const d = Math.hypot(x - cx, y - cy) - radius;
  return clamp01(0.5 - d);
}

/** 渲染 size x size RGBA Buffer（内部 SS 倍超采样） */
function render(size) {
  const W = size * SS;
  const S = W / 256; // 以 256 为设计基准
  const acc = new Float32Array(size * size * 4);

  const bg = { x: 0, y: 0, w: W, h: W, r: 58 * S };
  const bubble = { x: 46 * S, y: 52 * S, w: 164 * S, h: 122 * S, r: 30 * S };
  const tail = { x: 76 * S, y: 164 * S, w: 44 * S, h: 44 * S, r: 10 * S };
  const dots = [
    { x: 95 * S, y: 113 * S, c: [37, 99, 235] },
    { x: 128 * S, y: 113 * S, c: [59, 130, 246] },
    { x: 161 * S, y: 113 * S, c: [147, 184, 248] },
  ];
  const dotR = 11 * S;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const aBg = rrCoverage(px, py, bg.x, bg.y, bg.w, bg.h, bg.r);
      if (aBg <= 0) continue;

      // 垂直渐变 #5b96f8 -> #1d4ed8
      const t = clamp01(py / W);
      let r = lerp(91, 29, t);
      let g = lerp(150, 78, t);
      let b = lerp(248, 216, t);

      // 白色气泡（矩形 + 尾巴取并集）
      const aB = Math.max(
        rrCoverage(px, py, bubble.x, bubble.y, bubble.w, bubble.h, bubble.r),
        rrCoverage(px, py, tail.x, tail.y, tail.w, tail.h, tail.r),
      );
      if (aB > 0) {
        const k = aB * 0.97;
        r = lerp(r, 255, k);
        g = lerp(g, 255, k);
        b = lerp(b, 255, k);
      }

      // 三个流式点
      for (const d of dots) {
        const dist = Math.hypot(px - d.x, py - d.y);
        const aD = clamp01(0.5 + dotR - dist);
        if (aD > 0) {
          r = lerp(r, d.c[0], aD);
          g = lerp(g, d.c[1], aD);
          b = lerp(b, d.c[2], aD);
        }
      }

      // 关键：累加到下采样后的目标像素
      const idx = (((y / SS) | 0) * size + ((x / SS) | 0)) * 4;
      acc[idx] += r * aBg;
      acc[idx + 1] += g * aBg;
      acc[idx + 2] += b * aBg;
      acc[idx + 3] += 255 * aBg;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    out[i * 4 + 3] = Math.round(a);
    const alpha = a > 0 ? a / 255 : 1;
    out[i * 4] = Math.round(Math.min(255, acc[i * 4] / n / alpha));
    out[i * 4 + 1] = Math.round(Math.min(255, acc[i * 4 + 1] / n / alpha));
    out[i * 4 + 2] = Math.round(Math.min(255, acc[i * 4 + 2] / n / alpha));
  }
  return out;
}

/* ----------------------------- 输出 ----------------------------- */

const sizes = [16, 24, 32, 48, 64, 128, 256];
const rendered = sizes.map((size) => {
  const png = encodePNG(size, size, render(size));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  return { size, png };
});

fs.writeFileSync(path.join(outDir, 'icon.png'), rendered.find((r) => r.size === 256).png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO(rendered));

console.log(`图标已生成：${path.join(outDir, 'icon.ico')} + icon.png`);
for (const r of rendered) console.log(`  ${r.size}x${r.size}  ${r.png.length} bytes`);
