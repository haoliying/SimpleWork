import fs from 'node:fs';
import path from 'node:path';
import { envFiles } from './paths.js';

/**
 * 极简 .env 加载器（无第三方依赖）。
 * 已存在的环境变量优先级最高，不会被文件覆盖。
 */
export function loadEnv(cwd: string = process.cwd(), verbose = false): Record<string, string> {
  const loaded: Record<string, string> = {};
  // 顺序：全局 -> 项目根 -> 项目 .simplework（后者优先）
  const files = [...envFiles(cwd)].reverse();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key in process.env) continue; // 真实环境变量优先
        process.env[key] = value;
        loaded[key] = value;
      }
      if (verbose) console.log(`[env] 已加载 ${file}`);
    } catch (err) {
      if (verbose) console.warn(`[env] 读取失败 ${file}: ${(err as Error).message}`);
    }
  }
  return loaded;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** 展开字符串里的 ${VAR} / $VAR；未定义时返回空字符串（缺失的 key 由 doctor 报告） */
export function expandString(input: string): string {
  if (!input.includes('$')) return input;
  return input.replace(PLACEHOLDER, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    return process.env[name] ?? '';
  });
}

/** 递归展开对象/数组里的所有字符串占位符 */
export function expandDeep<T>(value: T): T {
  if (typeof value === 'string') return expandString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandDeep(v);
    }
    return out as T;
  }
  return value;
}

/** 列出配置里引用了哪些环境变量 */
export function referencedEnvVars(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) {
    out.add(m[1] ?? m[2] ?? '');
  }
  return [...out].filter(Boolean);
}

export function readTextIfExists(file: string): string | null {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

export function resolveWorkspace(cwd: string): string {
  return path.resolve(cwd);
}

/**
 * 写入/更新单个环境变量到 .env 文件（保留其它行与注释），并同步到当前进程。
 * 用于「在界面里直接填 API Key」，避免用户手动找文件。
 */
export function writeEnvVar(
  file: string,
  key: string,
  value: string,
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(file);
  const raw = existed ? fs.readFileSync(file, 'utf8') : '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (!existed) {
      next.push('# SimpleWork 本地密钥（仅保存在本机，不会上传）');
    }
    next.push(`${key}=${value}`);
  }
  // 去掉尾部多余空行
  while (next.length && next[next.length - 1] === '') next.pop();
  fs.writeFileSync(file, `${next.join('\n')}\n`, 'utf8');
  process.env[key] = value;
}
