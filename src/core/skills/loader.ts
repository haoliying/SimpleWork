import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SKILLS_DIR, globalDir, skillDirs } from '../paths.js';

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 所在目录 */
  dir: string;
  file: string;
  scope: 'project' | 'user' | 'builtin';
  source?: string;
  license?: string;
  allowedTools?: string[];
  /** frontmatter 里出现的其它字段 */
  extra?: Record<string, string>;
}

const FRONT_MATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/** 极简 YAML frontmatter 解析（够用即可：key: value + 多行续接） */
export function parseFrontMatter(raw: string): { data: Record<string, string>; body: string } {
  const m = raw.match(FRONT_MATTER);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      let value = kv[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      data[lastKey] = value;
    } else if (lastKey && /^\s+/.test(line)) {
      data[lastKey] = `${data[lastKey] ?? ''} ${line.trim()}`.trim();
    }
  }
  return { data, body: raw.slice(m[0].length) };
}

export class SkillRegistry {
  readonly cwd: string;
  private cache: SkillMeta[] | null = null;
  private loaded = new Set<string>();

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  reload(): void {
    this.cache = null;
  }

  /** 扫描所有 skill 目录（项目级 > 用户级 > 出厂） */
  list(): SkillMeta[] {
    if (this.cache) return this.cache;
    const found = new Map<string, SkillMeta>();
    const dirs = skillDirs(this.cwd);
    for (const base of dirs) {
      const isBuiltin = path.resolve(base) === path.resolve(BUILTIN_SKILLS_DIR);
      const underGlobal = path.resolve(base).startsWith(path.resolve(globalDir()));
      const underProjectCfg = base.split(path.sep).includes('.simplework') && !underGlobal;
      const scope: SkillMeta['scope'] = underProjectCfg
        ? 'project'
        : isBuiltin
          ? 'builtin'
          : underGlobal
            ? 'user'
            : base.startsWith(path.resolve(this.cwd))
              ? 'project'
              : 'user';
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        const file = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        if (found.has(entry.name)) continue;
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const { data } = parseFrontMatter(raw);
          const name = (data.name || entry.name).trim();
          found.set(name, {
            name,
            description: (data.description || '').trim(),
            dir,
            file,
            scope: dir.startsWith(path.join(this.cwd)) ? 'project' : scope,
            license: data.license,
            allowedTools: data['allowed-tools']
              ? data['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
            extra: data,
          });
        } catch {
          /* 忽略无法读取的 skill */
        }
      }
    }
    this.cache = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.cache;
  }

  get(name: string): SkillMeta | undefined {
    return this.list().find((s) => s.name === name || s.name.toLowerCase() === name.toLowerCase());
  }

  /** 列出 skill 目录下除 SKILL.md 外的资源文件（相对路径） */
  resources(name: string, max = 40): string[] {
    const meta = this.get(name);
    if (!meta) return [];
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (out.length >= max) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= max) return;
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, relPath);
        else if (e.name !== 'SKILL.md') out.push(relPath);
      }
    };
    try {
      walk(meta.dir, '');
    } catch {
      /* ignore */
    }
    return out;
  }

  /** 读取 SKILL.md 正文（渐进式加载：默认只给目录，调用时才读全文） */
  load(name: string): string {
    const meta = this.get(name);
    if (!meta) {
      const available = this.list().map((s) => s.name).join(', ') || '（无）';
      return `未找到 skill：${name}\n当前可用：${available}`;
    }
    const raw = fs.readFileSync(meta.file, 'utf8');
    const { body } = parseFrontMatter(raw);
    const res = this.resources(name);
    const sections = [
      `# Skill：${meta.name}`,
      `目录：${meta.dir}`,
      res.length ? `可用资源文件（用相对路径读取）：\n${res.map((r) => `  - ${path.join(meta.dir, r)}`).join('\n')}` : '',
      '---',
      body.trim(),
    ].filter(Boolean);
    this.loaded.add(name);
    return sections.join('\n');
  }

  /** 已在本轮会话中加载过的 skill */
  loadedNames(): string[] {
    return [...this.loaded];
  }

  /** 生成注入到 system prompt 的目录（只有 name + description，成本极低） */
  catalog(): string {
    const all = this.list();
    if (!all.length) return '（当前没有安装任何 Skill。可执行 sw skills install <name> 安装）';
    return all
      .map((s) => `- ${s.name}：${s.description || '（无描述）'} [${s.scope}]`)
      .join('\n');
  }
}
