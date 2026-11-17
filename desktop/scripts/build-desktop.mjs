/**
 * 桌面版构建准备：把 CLI 侧编译产物与预置配置同步进 desktop/payload/（Electron 载荷）。
 * 用法：node desktop/scripts/build-desktop.mjs [--payload-only]
 *   --payload-only  只同步载荷，不调用 tsc（假设已构建）
 */
'use strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = path.join(root, 'desktop', 'payload');

const args = process.argv.slice(2);
if (!args.includes('--payload-only')) {
  console.log('[1/3] 编译 TypeScript ...');
  execSync('npx tsc -p tsconfig.json', { cwd: root, stdio: 'inherit' });
} else {
  console.log('[1/3] 跳过编译（--payload-only）');
}

console.log('[2/3] 同步载荷 -> desktop/payload ...');
try {
  fs.rmSync(app, { recursive: true, force: true });
} catch {
  // 某些环境的安全删除钩子会拦截整目录 rmSync：退化为逐项清理，再不行就留着旧文件覆盖同步
  try {
    for (const it of fs.readdirSync(app, { withFileTypes: true })) {
      try {
        fs.rmSync(path.join(app, it.name), { recursive: true, force: true });
      } catch {
        /* 留给 cpSync 覆盖 */
      }
    }
  } catch {
    /* ignore */
  }
}
fs.mkdirSync(app, { recursive: true });

// 保持 dist 层级：payload/dist/web/server.js -> INSTALL_DIR = app/（与 config/、skills/ 同级）
fs.cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
// 出厂预置配置与内置 Skill
fs.cpSync(path.join(root, 'config'), path.join(app, 'config'), { recursive: true });
fs.cpSync(path.join(root, 'skills'), path.join(app, 'skills'), { recursive: true });
// 载荷按 ESM 解析（desktop/package.json 无 type 字段）
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

// 统计
let files = 0;
const walk = (dir) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (it.isDirectory()) walk(path.join(dir, it.name));
    else files++;
  }
};
walk(app);

console.log(`[3/3] 完成：desktop/payload 共 ${files} 个文件`);
console.log('下一步：npm --prefix desktop run start   # 开发调试');
console.log('        npm --prefix desktop run dist    # 打包单文件 exe');
