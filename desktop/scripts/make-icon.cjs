/**
 * 用 Electron 离屏渲染生成应用图标（SVG -> PNG 多尺寸 -> ICO）。
 * 用法：node scripts/make-icon.cjs  （需要在 desktop 依赖装好后运行）
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const root = path.resolve(__dirname, '..', '..');
const outDir = path.join(root, 'desktop', 'build');
fs.mkdirSync(outDir, { recursive: true });

/* ---------------- ICO 合成（各帧 PNG 存储，Vista+ 支持） ---------------- */

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
function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  const blobs = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(img.png);
    offset += img.png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------------- 图标 SVG（对话框 + 三个流式点） ---------------- */

function svgFor(size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b96f8"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="244" height="244" rx="58" fill="url(#bg)"/>
  <rect x="6" y="6" width="244" height="244" rx="58" fill="url(#gloss)"/>
  <rect x="46" y="52" width="164" height="122" rx="30" fill="#ffffff"/>
  <path d="M 78 166 L 78 200 Q 78 208 85 203 L 124 168 Z" fill="#ffffff"/>
  <circle cx="95" cy="113" r="11" fill="#2563eb"/>
  <circle cx="128" cy="113" r="11" fill="#3b82f6" opacity="0.85"/>
  <circle cx="161" cy="113" r="11" fill="#93b8f8" opacity="0.7"/>
</svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
  svg{display:block}
  </style></head><body>${svg}</body></html>`;
}

app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const results = [];
  try {
    for (const size of sizes) {
      const htmlFile = path.join(outDir, `_icon_${size}.html`);
      fs.writeFileSync(htmlFile, svgFor(size), 'utf8');
      const win = new BrowserWindow({
        show: false,
        width: size,
        height: size,
        useContentSize: true,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true },
      });
      await win.loadFile(htmlFile);
      await new Promise((r) => setTimeout(r, 80));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      const png = img.toPNG();
      const file = path.join(outDir, `icon-${size}.png`);
      fs.writeFileSync(file, png);
      results.push({ size, png });
      console.log(`  ${size}x${size} -> ${path.basename(file)} (${png.length} bytes)`);
      win.destroy();
      fs.rmSync(htmlFile, { force: true });
    }
    fs.writeFileSync(path.join(outDir, 'icon.png'), results.find((r) => r.size === 256).png);
    fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO(results));
    console.log(`图标已生成：${path.join(outDir, 'icon.ico')} / icon.png`);
  } catch (err) {
    console.error('生成失败：', err);
    app.exit(1);
    return;
  }
  app.exit(0);
});
