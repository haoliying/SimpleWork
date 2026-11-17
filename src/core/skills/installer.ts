import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ConfigStore, FeaturedSkillDef, SkillSourceDef, SkillsConfig } from '../config.js';
import { globalDir, projectDir, skillInstallDir } from '../paths.js';
import { httpFetch } from '../http.js';

export interface InstallTarget {
  repo: string;
  branch: string;
  subPath: string;
  name: string;
  sourceId?: string;
}

/** 解析安装目标：featured 名称 或 owner/repo[/子路径...] */
export function resolveTarget(store: ConfigStore, spec: string): InstallTarget {
  const trim = spec.trim().replace(/^\/+|\/+$/g, '');
  const featured = store.skills.featured.find(
    (f) => f.name === trim || f.name.toLowerCase() === trim.toLowerCase(),
  );
  if (featured) {
    const src = store.skills.sources.find((s) => s.id === featured.source);
    if (!src) throw new Error(`featured 条目 ${featured.name} 指向了未知来源：${featured.source}`);
    return {
      repo: src.repo,
      branch: src.branch ?? 'main',
      subPath: [src.basePath, featured.path].filter(Boolean).join('/'),
      name: featured.name,
      sourceId: src.id,
    };
  }

  // owner/repo 或 owner/repo/path/to/skill
  const parts = trim.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `无法解析「${spec}」。请使用 featured 里的名称（sw skills search 查看），或完整路径 owner/repo/子目录`,
    );
  }
  const repo = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2);
  const fromSource = store.skills.sources.find((s) => s.repo === repo);
  const subPath = rest.length ? rest.join('/') : (fromSource?.basePath ?? '');
  const name = rest.length ? (rest[rest.length - 1] as string) : repo.split('/')[1]!;
  return { repo, branch: fromSource?.branch ?? 'main', subPath, name, sourceId: fromSource?.id };
}

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 方式一：git sparse checkout（只拉目标子目录，最快） */
function cloneSparse(target: InstallTarget, destDir: string): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-skill-'));
  try {
    if (!run('git', ['init', '-q'], tmp).ok) return false;
    if (!run('git', ['remote', 'add', 'origin', `https://github.com/${target.repo}.git`], tmp).ok)
      return false;
    run('git', ['config', 'core.sparseCheckout', 'true'], tmp);
    const sparseFile = path.join(tmp, '.git', 'info', 'sparse-checkout');
    fs.mkdirSync(path.dirname(sparseFile), { recursive: true });
    fs.writeFileSync(sparseFile, `${target.subPath}/*\n`, 'utf8');
    const pull = run('git', ['pull', '--depth', '1', 'origin', target.branch], tmp);
    if (!pull.ok) return false;
    const src = path.join(tmp, ...target.subPath.split('/'));
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) return false;
    copyDir(src, destDir);
    return true;
  } catch {
    return false;
  } finally {
    rmDir(tmp);
  }
}

/** 方式二：下载 tarball 后用系统 tar 解压（git 不可用时兜底） */
async function cloneTarball(target: InstallTarget, destDir: string): Promise<boolean> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-skill-'));
  try {
    const url = `https://codeload.github.com/${target.repo}/tar.gz/${target.branch}`;
    const res = await httpFetch(url, { timeoutMs: 120000 });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const tarPath = path.join(tmp, 'src.tar.gz');
    fs.writeFileSync(tarPath, buf);
    try {
      execFileSync('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'ignore' });
    } catch {
      return false;
    }
    const roots = fs
      .readdirSync(tmp, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(tmp, d.name));
    for (const root of roots) {
      const src = path.join(root, ...target.subPath.split('/'));
      if (fs.existsSync(path.join(src, 'SKILL.md'))) {
        copyDir(src, destDir);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    rmDir(tmp);
  }
}

export interface InstallResult {
  name: string;
  dir: string;
  source?: string;
  repo: string;
  subPath: string;
}

/**
 * 安装一个 Skill 到本地（离线可用）。
 * @param targetDir 指定安装位置，默认项目级 <cwd>/.simplework/skills，否则 ~/.simplework/skills
 */
export async function installSkill(
  store: ConfigStore,
  spec: string,
  opts: { cwd?: string; scope?: 'project' | 'user' } = {},
): Promise<InstallResult> {
  const cwd = opts.cwd ?? process.cwd();
  const target = resolveTarget(store, spec);
  const base =
    opts.scope === 'user'
      ? path.join(globalDir(), 'skills')
      : opts.scope === 'project'
        ? path.join(projectDir(cwd) ?? globalDir(), 'skills')
        : skillInstallDir(cwd);
  fs.mkdirSync(base, { recursive: true });
  const destDir = path.join(base, target.name);
  if (fs.existsSync(destDir)) rmDir(destDir);

  let ok = false;
  try {
    ok = cloneSparse(target, destDir);
  } catch {
    ok = false;
  }
  if (!ok) {
    ok = await cloneTarball(target, destDir);
  }
  if (!ok || !fs.existsSync(path.join(destDir, 'SKILL.md'))) {
    rmDir(destDir);
    throw new Error(
      `下载失败：${target.repo}/${target.subPath}（请确认仓库与路径存在，或检查网络/代理设置；仓库主页 https://github.com/${target.repo}）`,
    );
  }

  // 记录到 skills.json 的 installed 列表
  try {
    const cfg = JSON.parse(JSON.stringify(store.skills)) as SkillsConfig;
    const installed = (cfg.installed ?? []).filter((i) => i.name !== target.name);
    installed.push({
      name: target.name,
      source: target.sourceId ?? target.repo,
      installedAt: new Date().toISOString(),
    });
    cfg.installed = installed;
    store.saveSkills(cfg);
  } catch {
    /* installed 记录失败不影响使用 */
  }

  return { name: target.name, dir: destDir, source: target.sourceId, repo: target.repo, subPath: target.subPath };
}

export function removeSkill(store: ConfigStore, name: string, cwd: string = process.cwd()): string {
  const candidates = [
    path.join(projectDir(cwd) ?? '', 'skills', name),
    path.join(cwd, 'skills', name),
    path.join(globalDir(), 'skills', name),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      rmDir(dir);
      try {
        const cfg = JSON.parse(JSON.stringify(store.skills)) as SkillsConfig;
        cfg.installed = (cfg.installed ?? []).filter((i) => i.name !== name);
        store.saveSkills(cfg);
      } catch {
        /* ignore */
      }
      return dir;
    }
  }
  throw new Error(`未找到已安装的 skill：${name}`);
}

export interface RemoteSkillHit {
  name: string;
  source: string;
  sourceName: string;
  repo: string;
  subPath: string;
  installed: boolean;
  featured?: boolean;
  desc?: string;
}

export interface SearchOutcome {
  hits: RemoteSkillHit[];
  /** 在线检索是否失败（例如 GitHub API 限流） */
  onlineError?: string;
  /** 在线通道补充了多少条 */
  onlineCount: number;
}

/**
 * 检索 Skill：
 * 1) 离线：直接匹配本地预置的 featured 清单（不联网，永远可用）
 * 2) 在线：列出各源仓库里的目录（配置了 GITHUB_TOKEN 时限额更高）
 */
export async function searchRemote(
  store: ConfigStore,
  keyword: string,
  cwd: string = process.cwd(),
): Promise<SearchOutcome> {
  const kw = keyword.trim().toLowerCase();
  const local = new Set(
    [
      ...(projectDir(cwd) ? safeReadDir(path.join(projectDir(cwd)!, 'skills')) : []),
      ...safeReadDir(path.join(globalDir(), 'skills')),
    ].map((s) => s.toLowerCase()),
  );
  const seen = new Set<string>();
  const results: RemoteSkillHit[] = [];
  const push = (h: RemoteSkillHit) => {
    const key = `${h.source}:${h.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(h);
  };

  // 1) 离线：featured 清单
  for (const f of store.skills.featured) {
    const src = store.skills.sources.find((s) => s.id === f.source);
    const hay = `${f.name} ${f.desc ?? ''} ${(f.tags ?? []).join(' ')} ${src?.name ?? ''}`.toLowerCase();
    if (kw && !hay.includes(kw)) continue;
    push({
      name: f.name,
      source: f.source,
      sourceName: src?.name ?? f.source,
      repo: src?.repo ?? '',
      subPath: [src?.basePath, f.path].filter(Boolean).join('/'),
      installed: local.has(f.name.toLowerCase()),
      featured: true,
      desc: f.desc,
    });
  }

  // 2) 在线：GitHub API
  let onlineError: string | undefined;
  let onlineCount = 0;
  await Promise.all(
    store.skills.sources.map(async (src: SkillSourceDef) => {
      const apiPath = src.basePath ?? '';
      const url = `https://api.github.com/repos/${src.repo}/contents/${apiPath}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SimpleWork',
      };
      const token = (process.env.GITHUB_TOKEN ?? '').trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        const res = await httpFetch(url, { headers, timeoutMs: 20000 });
        if (!res.ok) {
          onlineError =
            res.status === 403
              ? 'GitHub API 限流（可设置 GITHUB_TOKEN 提高限额）；已展示本地精选清单'
              : `GitHub API 返回 ${res.status}；已展示本地精选清单`;
          return;
        }
        const json = (await res.json()) as { name: string; type: string }[];
        for (const item of json) {
          if (item.type !== 'dir') continue;
          const hay = `${item.name} ${src.name}`.toLowerCase();
          if (kw && !hay.includes(kw)) continue;
          onlineCount++;
          push({
            name: item.name,
            source: src.id,
            sourceName: src.name,
            repo: src.repo,
            subPath: [src.basePath, item.name].filter(Boolean).join('/'),
            installed: local.has(item.name.toLowerCase()),
            featured: results.some((r) => r.source === src.id && r.name === item.name),
          });
        }
      } catch (e) {
        onlineError = `在线检索失败：${(e as Error).message}`;
      }
    }),
  );

  return { hits: sortHits(results), onlineError, onlineCount };
}

function sortHits(list: RemoteSkillHit[]): RemoteSkillHit[] {
  return list.sort(
    (a, b) =>
      Number(b.featured ?? false) - Number(a.featured ?? false) ||
      Number(a.installed) - Number(b.installed) ||
      a.name.localeCompare(b.name),
  );
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
