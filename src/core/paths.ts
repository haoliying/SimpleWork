import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'SimpleWork';
export const CONFIG_DIR_NAME = '.simplework';

const here = path.dirname(fileURLToPath(import.meta.url));

/** SimpleWork 安装目录（dist/core -> dist -> 项目根） */
export const INSTALL_DIR = path.resolve(here, '..', '..');
/** 出厂预置配置目录：config/models.json / mcp.json / skills.json / config.json */
export const BUILTIN_CONFIG_DIR = path.join(INSTALL_DIR, 'config');
/** 出厂自带示例 Skill */
export const BUILTIN_SKILLS_DIR = path.join(INSTALL_DIR, 'skills');

/**
 * 用户级目录：默认 ~/.simplework。
 * 设置环境变量 SIMPLEWORK_CONFIG_DIR 可整体搬家（桌面版便携模式会把它指向 exe 同级目录）。
 */
export function globalDir(): string {
  const env = (process.env.SIMPLEWORK_CONFIG_DIR ?? '').trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** 项目级目录：<cwd>/.simplework（不存在返回 null） */
export function projectDir(cwd: string = process.cwd()): string | null {
  const p = path.join(cwd, CONFIG_DIR_NAME);
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 配置文件查找顺序：项目级 -> 用户级 -> 出厂预置
 */
export function locate(fileName: string, cwd: string = process.cwd()): string | null {
  const candidates = [
    path.join(cwd, CONFIG_DIR_NAME, fileName),
    path.join(globalDir(), fileName),
    path.join(BUILTIN_CONFIG_DIR, fileName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 写入时始终写到「项目级优先，否则用户级」的可写位置 */
export function writablePath(fileName: string, cwd: string = process.cwd()): string {
  const pd = projectDir(cwd);
  const base = pd ?? globalDir();
  ensureDir(base);
  return path.join(base, fileName);
}

/**
 * Skill 扫描目录（优先级从高到低）：
 * 1. 项目级 <cwd>/.simplework/skills
 * 2. 项目级 <cwd>/skills（老习惯）
 * 3. 用户级 ~/.simplework/skills
 * 4. 出厂 skills/
 */
export function skillDirs(cwd: string = process.cwd()): string[] {
  const dirs = [
    path.join(cwd, CONFIG_DIR_NAME, 'skills'),
    path.join(cwd, 'skills'),
    path.join(globalDir(), 'skills'),
    BUILTIN_SKILLS_DIR,
  ];
  return dirs.filter((d) => {
    try {
      return fs.existsSync(d) && fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Skill 默认安装位置 */
export function skillInstallDir(cwd: string = process.cwd()): string {
  const pd = projectDir(cwd);
  const base = pd ?? globalDir();
  const dir = path.join(base, 'skills');
  ensureDir(dir);
  return dir;
}

/** .env 文件查找顺序 */
export function envFiles(cwd: string = process.cwd()): string[] {
  return [
    path.join(cwd, CONFIG_DIR_NAME, '.env'),
    path.join(cwd, '.env'),
    path.join(globalDir(), '.env'),
  ];
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
