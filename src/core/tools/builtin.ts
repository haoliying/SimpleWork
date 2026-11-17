import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { httpFetch } from '../http.js';
import { expandString } from '../env.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
]);

function resolveIn(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[已截断，共 ${text.length} 字符]`;
}

/** ---------- shell ---------- */

interface ShellSpec {
  cmd: string;
  args: (command: string) => string[];
}

function detectShell(ctx: ToolContext): ShellSpec {
  const cfg = ctx.store.app.shell;
  if (process.platform !== 'win32') {
    const sh = cfg.default || 'bash';
    return { cmd: sh, args: (c) => ['-lc', c] };
  }
  const preferred = cfg.win32 || 'bash';
  if (preferred !== 'bash') {
    return { cmd: preferred, args: (c) => ['/c', c] };
  }
  for (const candidate of cfg.windowsBashCandidates ?? []) {
    if (candidate && fs.existsSync(candidate)) {
      return { cmd: candidate, args: (c) => ['-lc', c] };
    }
  }
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return { cmd: 'bash', args: (c) => ['-lc', c] };
  // 最后兜底：PowerShell
  return { cmd: 'powershell.exe', args: (c) => ['-NoProfile', '-Command', c] };
}

function runShell(command: string, ctx: ToolContext, timeoutMs: number): Promise<{ code: number; out: string }> {
  const shell = detectShell(ctx);
  return new Promise((resolve) => {
    const child = spawn(shell.cmd, shell.args(command), {
      cwd: ctx.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve({ code: -1, out: `${out}\n[命令超时 ${timeoutMs}ms，已终止]` });
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: -1, out: `执行失败：${err.message}` });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, out });
    });
    ctx.signal?.addEventListener('abort', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ code: -1, out: `${out}\n[已取消]` });
    });
  });
}

/** ---------- 文件遍历 ---------- */

function walk(dir: string, out: string[], max: number, filter?: (rel: string) => boolean): void {
  if (out.length >= max) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out, max, filter);
    } else {
      const rel = path.relative(dir, path.join(dir, e.name));
      if (!filter || filter(path.join(path.basename(dir), rel))) out.push(path.join(dir, e.name));
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
      } else {
        re += '[^/\\\\]*';
      }
    } else if (c === '?') {
      re += '[^/\\\\]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** ---------- 工具定义 ---------- */

export const builtinTools: Tool[] = [
  {
    name: 'read_file',
    description: '读取文件内容（带行号）。支持 offset/limit 分段读取大文件。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或相对当前工作目录的路径' },
        offset: { type: 'number', description: '从第几行开始（1 起，可选）' },
        limit: { type: 'number', description: '最多读多少行（可选）' },
      },
      required: ['path'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const file = resolveIn(ctx.cwd, String(args.path));
      if (!fs.existsSync(file)) return { content: `文件不存在：${file}`, isError: true };
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return { content: `这是一个目录，请用 list_dir：${file}`, isError: true };
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const start = Math.max(1, Number(args.offset ?? 1));
      const end = args.limit ? Math.min(lines.length, start + Number(args.limit) - 1) : lines.length;
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
      return {
        content: truncate(
          `${file}（共 ${lines.length} 行，显示 ${start}-${end}）\n${numbered}`,
          ctx.store.app.tools.maxOutputChars,
        ),
        meta: { file },
      };
    },
  },
  {
    name: 'write_file',
    description: '写入文件（会覆盖）。父目录自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const file = resolveIn(ctx.cwd, String(args.path));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(args.content ?? ''), 'utf8');
      return { content: `已写入 ${file}（${String(args.content ?? '').length} 字符）`, meta: { file } };
    },
  },
  {
    name: 'edit_file',
    description: '精确替换文件中的一段文本（old_string 必须在文件中唯一）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（需唯一）' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const file = resolveIn(ctx.cwd, String(args.path));
      if (!fs.existsSync(file)) return { content: `文件不存在：${file}`, isError: true };
      const raw = fs.readFileSync(file, 'utf8');
      const oldStr = String(args.old_string);
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return { content: `未找到目标文本，替换失败：${file}`, isError: true };
      if (count > 1) return { content: `目标文本出现 ${count} 次，不够唯一，请补充更多上下文：${file}`, isError: true };
      fs.writeFileSync(file, raw.replace(oldStr, String(args.new_string ?? '')), 'utf8');
      return { content: `已修改 ${file}`, meta: { file } };
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容（自动跳过 node_modules/.git 等）。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认当前工作目录' },
        recursive: { type: 'boolean', description: '是否递归列出（默认 false）' },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const dir = resolveIn(ctx.cwd, String(args.path ?? ctx.cwd));
      if (!fs.existsSync(dir)) return { content: `目录不存在：${dir}`, isError: true };
      const recursive = Boolean(args.recursive);
      if (!recursive) {
        const items = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
          const type = e.isDirectory() ? 'DIR ' : 'FILE';
          let size = '';
          try {
            if (e.isFile()) size = ` ${fs.statSync(path.join(dir, e.name)).size}B`;
          } catch {
            /* ignore */
          }
          return `${type} ${e.name}${size}`;
        });
        return { content: `${dir}\n${items.join('\n')}` };
      }
      const out: string[] = [];
      walk(dir, out, 500, (rel) => !rel.split(path.sep).some((seg) => IGNORE_DIRS.has(seg)));
      return { content: truncate(`${dir}\n${out.map((f) => path.relative(dir, f)).join('\n')}`, ctx.store.app.tools.maxOutputChars) };
    },
  },
  {
    name: 'glob',
    description: '按通配符查找文件，例如 **/*.ts、src/**/*.{js,ts}。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配符模式，如 **/*.ts' },
        path: { type: 'string', description: '搜索根目录，默认当前工作目录' },
        limit: { type: 'number', description: '最多返回多少条，默认 200' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const root = resolveIn(ctx.cwd, String(args.path ?? ctx.cwd));
      const limit = Number(args.limit ?? 200);
      const re = globToRegExp(String(args.pattern));
      const files: string[] = [];
      walk(root, files, 20000);
      const matched = files.filter((f) => {
        const rel = path.relative(root, f).split(path.sep).join('/');
        return re.test(rel) || re.test(f.split(path.sep).join('/'));
      });
      const list = matched.slice(0, limit).map((f) => path.relative(root, f).split(path.sep).join('/'));
      return {
        content: list.length
          ? `匹配 ${matched.length} 个（显示 ${list.length}）：\n${list.join('\n')}`
          : `没有匹配到：${args.pattern}`,
      };
    },
  },
  {
    name: 'grep',
    description: '在文件内容中按正则搜索，返回 文件:行号:内容。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索目录或文件，默认当前工作目录' },
        filePattern: { type: 'string', description: '只搜索匹配该通配符的文件，如 *.ts' },
        maxResults: { type: 'number', description: '最多返回多少条，默认 100' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const target = resolveIn(ctx.cwd, String(args.path ?? ctx.cwd));
      let re: RegExp;
      try {
        re = new RegExp(String(args.pattern), 'i');
      } catch (err) {
        return { content: `正则不合法：${(err as Error).message}`, isError: true };
      }
      const max = Number(args.maxResults ?? 100);
      const fileRe = args.filePattern ? globToRegExp(String(args.filePattern)) : null;
      const files: string[] = [];
      const stat = fs.statSync(target);
      if (stat.isFile()) files.push(target);
      else walk(target, files, 5000);
      const hits: string[] = [];
      for (const file of files) {
        if (hits.length >= max) break;
        const rel = path.relative(target.includes('.') && stat.isFile() ? path.dirname(target) : target, file)
          .split(path.sep)
          .join('/');
        if (fileRe && !fileRe.test(path.basename(file)) && !fileRe.test(rel)) continue;
        try {
          const size = fs.statSync(file).size;
          if (size > 2_000_000) continue;
          const text = fs.readFileSync(file, 'utf8');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (re.test(lines[i] ?? '')) hits.push(`${rel}:${i + 1}:${(lines[i] ?? '').trim().slice(0, 300)}`);
          }
        } catch {
          /* 二进制或不可读，跳过 */
        }
      }
      return {
        content: hits.length ? `命中 ${hits.length} 处：\n${hits.join('\n')}` : `没有匹配：${args.pattern}`,
      };
    },
  },
  {
    name: 'run_command',
    description: '在工作目录执行 shell 命令（Windows 优先 Git Bash，否则 PowerShell）。用于构建、测试、git 等。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '执行目录，默认当前工作目录' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认取配置值' },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const command = String(args.command ?? '');
      if (!command.trim()) return { content: '命令为空', isError: true };
      const timeout = Number(args.timeoutMs ?? ctx.store.app.tools.commandTimeoutMs);
      const subCtx: ToolContext = args.cwd ? { ...ctx, cwd: resolveIn(ctx.cwd, String(args.cwd)) } : ctx;
      const { code, out } = await runShell(command, subCtx, timeout);
      return {
        content: truncate(`$ ${command}\n[exit ${code}]\n${out || '（无输出）'}`, ctx.store.app.tools.maxOutputChars),
        isError: code !== 0,
        meta: { exitCode: code },
      };
    },
  },
  {
    name: 'web_search',
    description: '联网搜索。默认免费 DuckDuckGo；配置了 TAVILY_API_KEY 或 BRAVE_API_KEY 时自动改用对应 API。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        maxResults: { type: 'number', description: '最多返回几条，默认 8' },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const query = String(args.query ?? '').trim();
      const max = Number(args.maxResults ?? 8);
      if (!query) return { content: '搜索词为空', isError: true };
      const cfg = ctx.store.app.search;
      const tavily = (process.env[cfg.tavilyApiKeyEnv] ?? '').trim();
      const brave = (process.env[cfg.braveApiKeyEnv] ?? '').trim();

      if (tavily) {
        try {
          const res = await httpFetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: tavily, query, max_results: max }),
            timeoutMs: 30000,
          });
          const json = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
          const lines = (json.results ?? []).slice(0, max).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`);
          return { content: lines.length ? `[Tavily] ${query}\n${lines.join('\n')}` : `[Tavily] 无结果：${query}` };
        } catch (err) {
          return { content: `Tavily 搜索失败：${(err as Error).message}`, isError: true };
        }
      }

      if (brave) {
        try {
          const res = await httpFetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`,
            { headers: { Accept: 'application/json', 'X-Subscription-Token': brave }, timeoutMs: 30000 },
          );
          const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
          const lines = (json.web?.results ?? []).slice(0, max).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`);
          return { content: lines.length ? `[Brave] ${query}\n${lines.join('\n')}` : `[Brave] 无结果：${query}` };
        } catch (err) {
          return { content: `Brave 搜索失败：${(err as Error).message}`, isError: true };
        }
      }

      // 免密钥：DuckDuckGo HTML
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
      const endpoints = ['https://html.duckduckgo.com/html/', 'https://lite.duckduckgo.com/lite/'];
      for (const base of endpoints) {
        try {
          const res = await httpFetch(`${base}?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
            timeoutMs: 30000,
          });
          if (!res.ok) continue;
          const html = await res.text();
          const items: string[] = [];
          const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          const urls: string[] = [];
          let m: RegExpExecArray | null;
          while ((m = titleRe.exec(html)) && items.length < max) {
            urls.push(m[1]!);
            items.push(m[2]!.replace(/<[^>]+>/g, '').trim());
          }
          if (!items.length) {
            const altRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            while ((m = altRe.exec(html)) && items.length < max) {
              urls.push(m[1]!);
              items.push(m[2]!.replace(/<[^>]+>/g, '').trim());
            }
          }
          if (items.length) {
            const lines = items.map((t, i) => `${i + 1}. ${t}\n   ${decodeHtml(decodeURIComponent(urls[i] ?? ''))}`);
            return { content: `[DuckDuckGo] ${query}\n${lines.join('\n')}` };
          }
        } catch {
          /* 换下一个端点 */
        }
      }
      return { content: `搜索失败：${query}（可配置 TAVILY_API_KEY 获得更稳定的结果）`, isError: true };
    },
  },
  {
    name: 'web_fetch',
    description: '抓取网页并转成纯文本（自动去掉脚本/样式），适合读文档和文章。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网址' },
        maxChars: { type: 'number', description: '最多返回多少字符，默认 20000' },
      },
      required: ['url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const url = String(args.url ?? '').trim();
      const max = Number(args.maxChars ?? ctx.store.app.tools.maxOutputChars);
      if (!/^https?:\/\//i.test(url)) return { content: `URL 不合法：${url}`, isError: true };
      try {
        const res = await httpFetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          },
          timeoutMs: 45000,
        });
        const ctype = res.headers.get('content-type') ?? '';
        const text = await res.text();
        if (!res.ok) return { content: `抓取失败 HTTP ${res.status}：${url}`, isError: true };
        if (!ctype.includes('html')) return { content: truncate(text, max) };
        const cleaned = htmlToText(text);
        return { content: truncate(`${url}\n${cleaned}`, max) };
      } catch (err) {
        return { content: `抓取失败：${(err as Error).message}`, isError: true };
      }
    },
  },
  {
    name: 'todo_write',
    description: '记录/更新当前任务清单，用于多步骤任务时保持进度可见。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务列表，每项形如 { "text": "...", "status": "pending|in_progress|completed" }',
          items: { type: 'object' },
        },
      },
      required: ['todos'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const todos = (args.todos ?? []) as { text?: string; status?: string }[];
      const lines = todos.map((t, i) => `${i + 1}. [${t.status ?? 'pending'}] ${t.text ?? ''}`);
      const file = path.join(ctx.cwd, '.simplework', 'todos.md');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# 任务清单\n\n${lines.join('\n')}\n`, 'utf8');
      } catch {
        /* 写不了也不影响返回 */
      }
      return { content: `当前任务：\n${lines.join('\n')}` };
    },
  },
  {
    name: 'use_skill',
    description: '加载某个 Skill 的完整说明（SKILL.md 正文 + 资源文件清单）。当任务匹配某个 Skill 的描述时先调用它。',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称（见系统提示里的 Skill 目录）' },
      },
      required: ['name'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const name = String(args.name ?? '').trim();
      const body = ctx.skills.load(name);
      return { content: body, isError: body.startsWith('未找到 skill') };
    },
  },
];

export function builtinToolNames(): string[] {
  return builtinTools.map((t) => t.name);
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtml(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}
