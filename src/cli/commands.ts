import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { Session } from '../core/session.js';
import { ConfigStore, normalizeProviderDef, suggestProviderId } from '../core/config.js';
import type { Protocol } from '../core/config.js';
import { SkillRegistry } from '../core/skills/loader.js';
import { installSkill, removeSkill, searchRemote } from '../core/skills/installer.js';
import { createProvider } from '../core/llm/index.js';
import { McpManager } from '../core/mcp/manager.js';
import { BUILTIN_CONFIG_DIR, globalDir, projectDir, skillInstallDir } from '../core/paths.js';
import { writeEnvVar } from '../core/env.js';
import type { McpServerDef } from '../core/config.js';

/** 解析 --key value / --key=a,b / --flag 形式的命令行参数（同名多次出现收集成数组） */
function parseFlags(argv: string[]): Record<string, string | string[] | true> {
  const out: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1);
      out[k] = v.includes(',') ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[body] = next.includes(',') ? next.split(',').map((s) => s.trim()).filter(Boolean) : next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

function flagStr(v: string | string[] | true | undefined): string {
  if (v === undefined || v === true) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

function flagList(v: string | string[] | true | undefined): string[] {
  if (v === undefined || v === true) return [];
  return Array.isArray(v) ? v : [v];
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function ok(msg: string): void {
  console.log(`${C.green}✓${C.reset} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${C.yellow}!${C.reset} ${msg}`);
}
function err(msg: string): void {
  console.log(`${C.red}✗${C.reset} ${msg}`);
}
function info(msg: string): void {
  console.log(`${C.cyan}·${C.reset} ${msg}`);
}
function title(msg: string): void {
  console.log(`\n${C.bold}${msg}${C.reset}`);
}

/** 终端里中日韩字符占两列，padEnd 会错位，这里按显示宽度补齐 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6))
        ? 2
        : 1;
  }
  return w;
}

function padTo(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

export const HELP = `${C.bold}SimpleWork${C.reset} —— 本地优先的轻量 Agent 工作台

${C.bold}用法${C.reset}
  sw                        进入交互式对话
  sw ask "问题"              单轮问答（也可 echo "xxx" | sw ask）
  sw serve [--port 8787]     启动本地 Web 界面
  sw init [--here]           初始化本地配置目录
  sw doctor                  体检：密钥 / MCP / Skill / 网络

${C.bold}配置${C.reset}
  sw config path             显示生效的配置文件路径
  sw config list             打印当前主配置
  sw config get <a.b>        读取配置项，如 agent.maxTurns
  sw config set <a.b> <值>   写入配置项（自动识别数字/布尔/JSON）

${C.bold}模型${C.reset}
  sw models list             列出所有预置厂商与模型（标注是否已配 Key）
  sw models use deepseek     切换默认厂商（可写 deepseek:deepseek-chat）
  sw models add              添加自己的模型（交互式问答，或直接带参数）
  sw models remove <id>      删除自己添加的模型（出厂厂商会被隐藏）
  sw models fetch qwen       在线拉取该厂商真实模型列表并写回配置
  sw models test [provider]  发一条最小请求验证连通性

  例：sw models add --name "公司内部模型" --base-url https://llm.corp.com/v1 --key-env CORP_KEY --model gpt-4o --model claude-3

${C.bold}MCP${C.reset}
  sw mcp list                列出预置 MCP 服务器与连接状态
  sw mcp enable <id>         启用（写入本地配置）
  sw mcp disable <id>        停用
  sw mcp test <id>           单独连一次，打印它提供的工具
  sw mcp add <id> <command> [args...]   手动添加一个 stdio MCP

${C.bold}Skills${C.reset}
  sw skills list             已安装的 Skill
  sw skills search <关键词>    在线检索公开仓库里的免费 Skill
  sw skills install <名称>     安装（featured 名称或 owner/repo/子路径）
  sw skills remove <名称>      卸载
  sw skills create <名称>      在本机生成一个 Skill 模板

${C.bold}示例${C.reset}
  cp .env.example ~/.simplework/.env && 填写 DEEPSEEK_API_KEY
  sw models use deepseek && sw doctor
  sw skills install pdf && sw ask "帮我提取 ./a.pdf 的目录"
  sw mcp enable github && sw ask "看看这个仓库最近的 issue"
`;

/** ---------- init ---------- */

async function cmdInit(args: string[]): Promise<void> {
  const here = args.includes('--here');
  const base = here ? path.join(process.cwd(), '.simplework') : globalDir();
  fs.mkdirSync(path.join(base, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(base, 'memory'), { recursive: true });
  for (const f of ['models.json', 'mcp.json', 'skills.json', 'config.json']) {
    const src = path.join(BUILTIN_CONFIG_DIR, f);
    const dst = path.join(base, f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      info(`已生成 ${dst}`);
    } else if (fs.existsSync(dst)) {
      info(`已存在，跳过 ${dst}`);
    }
  }
  const envDst = path.join(base, '.env');
  if (!fs.existsSync(envDst)) {
    fs.copyFileSync(path.join(BUILTIN_CONFIG_DIR, '..', '.env.example'), envDst);
    ok(`已生成 ${envDst} ${C.dim}（请填入你的 API Key）${C.reset}`);
  }
  ok(`初始化完成：${base}`);
}

/** ---------- config ---------- */

function cmdConfig(args: string[], store: ConfigStore): void {
  const [sub, ...rest] = args;
  if (!sub || sub === 'path') {
    const pd = projectDir(process.cwd());
    title('配置文件查找顺序（后者覆盖前者）');
    console.log(`  1. 出厂预置   ${BUILTIN_CONFIG_DIR}`);
    console.log(`  2. 用户级     ${globalDir()}`);
    console.log(`  3. 项目级     ${pd ?? path.join(process.cwd(), '.simplework')} ${pd ? '' : C.dim + '（未创建，sw init --here 可生成）' + C.reset}`);
    console.log(`\n  .env 读取顺序：${['./.simplework/.env', './.env', '~/.simplework/.env'].join(' -> ')}`);
    return;
  }
  if (sub === 'list') {
    console.log(JSON.stringify(store.app, null, 2));
    return;
  }
  if (sub === 'get') {
    const value = getPath(store.app, rest[0] ?? '');
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (sub === 'set') {
    const key = rest[0];
    const rawValue = rest.slice(1).join(' ');
    if (!key || rawValue === '') {
      err('用法：sw config set <a.b.c> <值>');
      return;
    }
    const cfg = JSON.parse(JSON.stringify(store.app)) as Record<string, unknown>;
    setPath(cfg, key, parseValue(rawValue));
    store.save('config.json', cfg);
    ok(`已写入 ${key} = ${rawValue}`);
    return;
  }
  err(`未知子命令：config ${sub}`);
}

function getPath(obj: unknown, dot: string): unknown {
  return dot.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, dot: string, value: unknown): void {
  const keys = dot.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** ---------- models ---------- */

async function cmdModels(args: string[], store: ConfigStore): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'list') {
    title('预置大模型（✓ 已配 Key / ✗ 缺 Key / ○ 无需 Key）');
    for (const p of store.models.providers) {
      const key = store.resolveApiKey(p);
      const noKeyNeeded = !p.apiKeyEnv || p.id === 'ollama' || p.baseURL.includes('127.0.0.1') || p.baseURL.includes('localhost');
      const mark = key ? `${C.green}✓${C.reset}` : noKeyNeeded ? `${C.green}○${C.reset}` : `${C.red}✗${C.reset}`;
      const active = store.models.active.provider === p.id ? ` ${C.cyan}← 当前${C.reset}` : '';
      console.log(
        `${mark} ${C.bold}${padTo(p.id, 14)}${C.reset} ${padTo(String(p.name), 24)} ${C.dim}${p.protocol}${C.reset}${active}`,
      );
      console.log(`    ${C.gray}密钥：${p.apiKeyEnv ? '${' + p.apiKeyEnv + '}' : '(无)'}   baseURL：${p.baseURL}${C.reset}`);
      const models = p.models.map((m) => (store.models.active.provider === p.id && store.models.active.model === m.id ? `*${m.id}` : m.id));
      console.log(`    ${C.gray}模型：${models.join(', ')}${C.reset}`);
    }
    return;
  }
  if (sub === 'use') {
    const spec = rest[0];
    if (!spec) return err('用法：sw models use <provider> 或 <provider>:<model>');
    const [pid, mid] = spec.split(':');
    store.setActive(pid!, mid);
    ok(`已切换到 ${pid}${mid ? ':' + mid : ''}`);
    return;
  }
  if (sub === 'fetch') {
    const pid = rest[0];
    if (!pid) return err('用法：sw models fetch <provider>');
    const { provider } = createProvider(store, pid);
    info(`正在拉取 ${pid} 的模型列表...`);
    const models = await provider.listModels();
    if (!models.length) return err(`没有拉到模型（可能是 Key 无效或该服务不支持 /models）`);
    const cfg = JSON.parse(JSON.stringify(store.models)) as typeof store.models;
    const p = cfg.providers.find((x) => x.id === pid);
    if (!p) return err(`未找到供应商 ${pid}`);
    const existing = new Set(p.models.map((m) => m.id));
    p.models = [
      ...p.models,
      ...models.filter((m) => !existing.has(m)).map((m) => ({ id: m, label: m, tools: true })),
    ];
    store.saveModels(cfg);
    ok(`拉取到 ${models.length} 个模型，已写回配置（新增 ${models.filter((m) => !existing.has(m)).length} 个）`);
    console.log(C.gray + models.slice(0, 40).join(', ') + (models.length > 40 ? ' ...' : '') + C.reset);
    return;
  }

  if (sub === 'add') {
    // 参数式：sw models add --name "我的模型" --base-url https://x/v1 --model a --model b
    // 交互式：sw models add（逐项询问）
    const flags = parseFlags(rest);
    let name = flagStr(flags.name);
    let id = flagStr(flags.id);
    let protocol = (flagStr(flags.protocol) || 'openai') as Protocol;
    let baseURL = flagStr(flags['base-url']) || flagStr(flags.baseURL);
    let apiKeyEnv = flagStr(flags['key-env']);
    let apiKey = flagStr(flags.key);
    let defaultModel = flagStr(flags['default-model']);
    let models = flagList(flags.model);

    if (!name || !baseURL || !models.length) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string, def = '') => rl.question(`${q}${def ? ` ${C.gray}(${def})${C.reset}` : ''}: `);
      try {
        title('添加自定义模型（直接回车用默认值）');
        name = name || (await ask('显示名称', '我的模型')).trim() || '我的模型';
        id = id || (await ask('标识 id（英文小写）', suggestProviderId(name, store.models.providers.map((p) => p.id)))).trim();
        const protoIn = (await ask('协议 openai/anthropic/ollama', protocol)).trim();
        protocol = (protoIn || protocol) as Protocol;
        const urlDef = protocol === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.example.com/v1';
        baseURL = baseURL || (await ask('接口地址 baseURL', urlDef)).trim() || urlDef;
        apiKeyEnv = apiKeyEnv || (await ask('Key 环境变量名（可留空）', '')).trim();
        apiKey = apiKey || (await ask('API Key（可留空，稍后填 .env）', '')).trim();
        if (!models.length) {
          const line = (await ask('模型 ID（多个用逗号分隔）', '')).trim();
          models = line.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        }
      } finally {
        rl.close();
      }
    }

    const def = normalizeProviderDef({
      id: id || suggestProviderId(name, store.models.providers.map((p) => p.id)),
      name,
      protocol,
      baseURL,
      apiKeyEnv,
      defaultModel,
      models: models.map((m) => ({ id: String(m).split('|')[0].trim(), label: String(m).split('|')[1]?.trim() })),
      custom: true,
    });
    if (apiKey) {
      const envName = apiKeyEnv || `${def.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
      writeEnvVar(path.join(globalDir(), '.env'), envName, apiKey.trim());
      def.apiKeyEnv = envName;
    }
    const r = store.upsertProvider(def, { activate: true });
    ok(`已保存 ${def.id}（${def.name}）→ ${r.file}`);
    if (def.apiKeyEnv) info(`密钥变量：${def.apiKeyEnv}${apiKey ? '（已写入 .env）' : '（请在 .env 或环境变量里设置）'}`);
    info(`切换：sw models use ${def.id}`);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const pid = rest[0];
    if (!pid) return err('用法：sw models remove <provider-id>');
    const r = store.removeProvider(pid);
    ok(`已删除 ${pid}${r.hidden ? '（出厂供应商，已加入隐藏列表）' : ''} → ${r.file}`);
    return;
  }

  if (sub === 'test') {
    const pid = rest[0];
    const { provider, def, model } = createProvider(store, pid);
    info(`测试 ${def.name} / ${model} ...`);
    const started = Date.now();
    const res = await provider.chat({
      model,
      messages: [
        { role: 'system', content: '你是一个简洁的助手。' },
        { role: 'user', content: '只回复两个字：正常' },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    ok(`连通（${Date.now() - started}ms）：${(res.message.content ?? '').trim() || '（空回复）'}`);
    return;
  }
  err(`未知子命令：models ${sub}`);
}

/** ---------- mcp ---------- */

async function cmdMcp(args: string[], store: ConfigStore): Promise<void> {
  const [sub, ...rest] = args;
  const saveServers = (servers: McpServerDef[]) => {
    const cfg = JSON.parse(JSON.stringify(store.mcp)) as typeof store.mcp;
    cfg.servers = servers;
    store.saveMcp(cfg);
  };

  if (!sub || sub === 'list') {
    const mgr = new McpManager();
    const enabled = store.mcp.servers.filter((s) => s.enabled);
    title(`预置 MCP 服务器（${enabled.length}/${store.mcp.servers.length} 个启用）`);
    const statuses = await mgr.connectAll(store.mcp.servers, process.cwd(), 25000);
    const map = new Map(statuses.map((s) => [s.id, s]));
    for (const s of store.mcp.servers) {
      const st = map.get(s.id);
      const mark = !s.enabled ? `${C.gray}○${C.reset}` : st?.connected ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      const state = !s.enabled ? '已停用' : st?.connected ? `${st.toolCount} 个工具` : `失败：${(st?.error ?? '未知').slice(0, 80)}`;
      console.log(`${mark} ${C.bold}${padTo(s.id, 14)}${C.reset} ${padTo(String(s.name), 26)} ${state}`);
      if (s.needsKey && s.keyEnv) {
        const has = Boolean(process.env[s.keyEnv]);
        console.log(`    ${has ? C.green : C.yellow}需要密钥 ${s.keyEnv}：${has ? '已配置' : '未配置'}${C.reset}`);
      }
    }
    await mgr.closeAll();
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = rest[0];
    if (!id) return err(`用法：sw mcp ${sub} <id>`);
    const servers = store.mcp.servers.map((s) => (s.id === id ? { ...s, enabled: sub === 'enable' } : s));
    if (!store.mcp.servers.some((s) => s.id === id)) return err(`未找到 MCP 服务器：${id}`);
    saveServers(servers);
    ok(`${id} 已${sub === 'enable' ? '启用' : '停用'}（重启会话生效）`);
    return;
  }
  if (sub === 'test') {
    const id = rest[0];
    if (!id) return err('用法：sw mcp test <id>');
    const mgr = new McpManager();
    const def = store.mcp.servers.find((s) => s.id === id);
    if (!def) return err(`未找到 MCP 服务器：${id}`);
    info(`连接 ${id} ...`);
    const st = await mgr.connect({ ...def, enabled: true }, process.cwd(), 40000);
    if (st.connected) {
      ok(`连接成功，提供 ${st.toolCount} 个工具：`);
      console.log(C.gray + st.tools.join(', ') + C.reset);
    } else {
      err(`连接失败：${st.error}`);
    }
    await mgr.closeAll();
    return;
  }
  if (sub === 'add') {
    const [id, command, ...cmdArgs] = rest;
    if (!id || !command) return err('用法：sw mcp add <id> <command> [args...]');
    const servers = [
      ...store.mcp.servers.filter((s) => s.id !== id),
      { id, name: id, enabled: true, transport: 'stdio' as const, command, args: cmdArgs, note: '手动添加' },
    ];
    saveServers(servers);
    ok(`已添加 MCP 服务器 ${id}`);
    return;
  }
  err(`未知子命令：mcp ${sub}`);
}

/** ---------- skills ---------- */

async function cmdSkills(args: string[], store: ConfigStore): Promise<void> {
  const [sub, ...rest] = args;
  const registry = new SkillRegistry(process.cwd());

  if (!sub || sub === 'list') {
    const all = registry.list();
    title(`已安装 Skill（${all.length}）  ${C.dim}安装位置：${skillInstallDir(process.cwd())}${C.reset}`);
    if (!all.length) {
      console.log(`  还没有安装。试试：${C.cyan}sw skills search pdf${C.reset} 或 ${C.cyan}sw skills install pdf${C.reset}`);
      return;
    }
    for (const s of all) {
      console.log(`${C.green}•${C.reset} ${C.bold}${s.name}${C.reset} ${C.gray}[${s.scope}]${C.reset}`);
      console.log(`  ${C.gray}${s.description || '（无描述）'}${C.reset}`);
      console.log(`  ${C.gray}${s.dir}${C.reset}`);
    }
    return;
  }
  if (sub === 'search') {
    const kw = rest.join(' ');
    info(`检索「${kw || '全部'}」...`);
    const { hits, onlineError } = await searchRemote(store, kw);
    if (onlineError) warn(onlineError);
    if (!hits.length) return warn('没有匹配结果');
    title(`检索结果（${hits.length}）`);
    for (const h of hits) {
      const mark = h.installed ? `${C.green}✓已装${C.reset}` : `${C.gray}  未装${C.reset}`;
      console.log(`${mark} ${C.bold}${h.name}${C.reset} ${C.gray}(${h.source})${C.reset}${h.featured ? ' ' + C.cyan + '精选' + C.reset : ''}`);
      if (h.desc) console.log(`   ${C.gray}${h.desc}${C.reset}`);
      console.log(`   ${C.gray}sw skills install ${h.name}${C.reset}`);
    }
    return;
  }
  if (sub === 'install') {
    const spec = rest[0];
    if (!spec) return err('用法：sw skills install <名称|owner/repo/子路径> [--user]');
    const scope = rest.includes('--user') ? 'user' : rest.includes('--project') ? 'project' : undefined;
    info(`下载中：${spec} ...`);
    const r = await installSkill(store, spec, { scope });
    ok(`已安装 ${r.name} -> ${r.dir}`);
    return;
  }
  if (sub === 'remove') {
    const name = rest[0];
    if (!name) return err('用法：sw skills remove <名称>');
    const dir = removeSkill(store, name);
    ok(`已卸载 ${name}（${dir}）`);
    return;
  }
  if (sub === 'create') {
    const name = rest[0];
    if (!name) return err('用法：sw skills create <名称>');
    const dir = path.join(skillInstallDir(process.cwd()), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 一句话说明这个 Skill 做什么、什么时候该用它\n---\n\n# ${name}\n\n## 适用场景\n\n- 场景 1\n\n## 操作步骤\n\n1. 第一步\n2. 第二步\n\n## 注意事项\n\n- 注意点\n`,
      'utf8',
    );
    ok(`已创建模板：${path.join(dir, 'SKILL.md')}`);
    return;
  }
  err(`未知子命令：skills ${sub}`);
}

/** ---------- doctor ---------- */

async function cmdDoctor(store: ConfigStore): Promise<void> {
  title('SimpleWork 体检');
  const pd = projectDir(process.cwd());
  console.log(`配置来源：${pd ? '项目级 ' + pd : '用户级 ' + globalDir()}`);

  // 1. 模型
  console.log(`\n${C.bold}模型${C.reset}`);
  let llm: ReturnType<typeof createProvider> | null = null;
  try {
    llm = createProvider(store);
  } catch (e) {
    err(`模型配置异常：${(e as Error).message}`);
  }
  if (llm) {
    const p = llm.def;
    console.log(`  当前：${p.name} / ${llm.model}`);
    console.log(`  baseURL：${p.baseURL}`);
    console.log(
      `  Key：${store.resolveApiKey(p) ? C.green + '已配置' + C.reset : C.red + '缺失（' + (p.apiKeyEnv ?? '') + '）' + C.reset}`,
    );
    const configured = store.models.providers.filter((x) => store.resolveApiKey(x)).length;
    console.log(`  已配 Key 的厂商：${configured}/${store.models.providers.length}（sw models use <id> 切换）`);
  }

  // 2. MCP
  console.log(`\n${C.bold}MCP${C.reset}`);
  const mgr = new McpManager();
  const statuses = await mgr.connectAll(store.mcp.servers, process.cwd(), 20000);
  for (const st of statuses) {
    const line = st.connected
      ? `${C.green}✓${C.reset} ${padTo(st.id, 14)} ${st.toolCount} 个工具`
      : `${C.red}✗${C.reset} ${padTo(st.id, 14)} ${(st.error ?? '').slice(0, 70)}`;
    console.log(`  ${line}`);
  }
  await mgr.closeAll();

  // 3. Skills
  console.log(`\n${C.bold}Skills${C.reset}`);
  const registry = new SkillRegistry(process.cwd());
  const list = registry.list();
  console.log(`  已安装：${list.length} 个${list.length ? ' -> ' + list.map((s) => s.name).join(', ') : ''}`);

  // 4. 运行时
  console.log(`\n${C.bold}运行时${C.reset}`);
  for (const c of ['bash', 'git', 'npx', 'uvx']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
    console.log(
      `  ${r.status === 0 ? C.green + '✓' : C.yellow + '!'}${C.reset} ${c}${r.status === 0 ? '' : '（不可用，相关 MCP 会失败）'}`,
    );
  }
  console.log(`  代理：${process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? '已设置 ' + (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) : '未设置'}`);
  console.log(`  系统：${os.platform()} ${os.release()}`);
  console.log(`\n${C.dim}提示：缺 Key 就编辑 ${path.join(globalDir(), '.env')}；MCP 失败通常是缺 npx/uvx 或网络不通。${C.reset}`);
}

/** ---------- 对话 ---------- */

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
    if (process.stdin.isTTY) resolve('');
  });
}

async function cmdAsk(text: string, providerId?: string, modelId?: string): Promise<void> {
  const session = await Session.create({
    providerId,
    modelId,
    onMcpStatus: (s) => {
      if (s.connected) info(`MCP ${s.id} 已连接（${s.toolCount} 工具）`);
      else warn(`MCP ${s.id} 连接失败：${(s.error ?? '').slice(0, 100)}`);
    },
  });
  try {
    let printed = false;
    const answer = await session.agent.run(text, {
      onText: (d) => {
        printed = true;
        process.stdout.write(d);
      },
      onToolStart: (name, args) => {
        console.log(`\n${C.dim}› 调用 ${name} ${JSON.stringify(args).slice(0, 160)}${C.reset}`);
      },
      onError: (m) => warn(m),
    });
    if (!printed) console.log(answer);
    console.log('');
  } finally {
    await session.dispose();
  }
}

async function cmdRepl(providerId?: string, modelId?: string): Promise<void> {
  const session = await Session.create({
    providerId,
    modelId,
    onMcpStatus: (s) => {
      if (s.connected) ok(`MCP ${s.id} 已连接（${s.toolCount} 工具）`);
      else warn(`MCP ${s.id} 连接失败：${(s.error ?? '').slice(0, 100)}`);
    },
  });
  const store = session.store;
  const { provider, model } = (() => {
    const p = store.provider(providerId);
    return { provider: p, model: modelId || (providerId ? p.defaultModel : store.models.active.model) || p.defaultModel! };
  })();

  console.log(
    `\n${C.bold}SimpleWork${C.reset} ${C.dim}v0.1.0${C.reset}  ${C.cyan}${provider.name} / ${model}${C.reset}`,
  );
  console.log(
    `${C.gray}输入 /help 查看命令，/exit 退出；可用 Skill：${session.skills.list().map((s) => s.name).join(', ') || '无'}${C.reset}\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q);

  try {
    while (true) {
      const line = (await ask(`${C.cyan}你 › ${C.reset}`)).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit' || line === 'exit') break;
      if (line === '/help') {
        console.log(`/help 帮助  /clear 清空上下文  /model 显示当前模型  /models 切换模型  /skills 列出 Skill  /mcp MCP 状态  /exit 退出`);
        continue;
      }
      if (line === '/clear') {
        session.agent.clear();
        ok('上下文已清空');
        continue;
      }
      if (line === '/model') {
        console.log(`${provider.name} / ${model}`);
        continue;
      }
      if (line === '/skills') {
        for (const s of session.skills.list()) console.log(`  ${s.name}: ${s.description}`);
        continue;
      }
      if (line === '/mcp') {
        for (const s of session.mcp.status()) {
          console.log(`  ${s.connected ? '✓' : '✗'} ${s.id} — ${s.connected ? s.toolCount + ' 工具' : s.error}`);
        }
        continue;
      }
      if (line.startsWith('/models')) {
        const spec = line.split(/\s+/)[1];
        if (!spec) {
          console.log(store.models.providers.map((p) => `  ${p.id}`).join('\n'));
        } else {
          const [pid, mid] = spec.split(':');
          store.setActive(pid!, mid);
          ok(`已切换（下次启动生效）：${pid}${mid ? ':' + mid : ''}`);
        }
        continue;
      }

      process.stdout.write(`${C.green}SimpleWork › ${C.reset}`);
      try {
        await session.agent.run(line, {
          onText: (d) => process.stdout.write(d),
          onToolStart: (name, args) => {
            process.stdout.write(`\n${C.dim}  › ${name} ${JSON.stringify(args).slice(0, 140)}${C.reset}\n`);
          },
          onError: (m) => warn(m),
        });
        console.log('\n');
      } catch (e) {
        err((e as Error).message);
      }
    }
  } finally {
    rl.close();
    await session.dispose();
  }
}

/** ---------- 入口 ---------- */

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
    console.log('SimpleWork v0.1.0');
    return;
  }
  if (cmd === 'init') return cmdInit(rest);
  if (cmd === 'serve') {
    const { startWebServer } = await import('../web/server.js');
    const portIdx = rest.indexOf('--port');
    const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : undefined;
    const handle = await startWebServer({
      port,
      handleSignals: true,
      mcp: 'background',
      onStatus: (line: string) => console.log(`  ${line}`),
    });
    console.log(`\n  ${C.bold}SimpleWork Web 界面已启动${C.reset}：${handle.url}`);
    console.log(`  工作目录：${handle.cwd}`);
    console.log(`  按 Ctrl+C 停止\n`);
    return;
  }

  const store = new ConfigStore(process.cwd());

  if (cmd === 'config') return cmdConfig(rest, store);
  if (cmd === 'models') return cmdModels(rest, store);
  if (cmd === 'mcp') return cmdMcp(rest, store);
  if (cmd === 'skills') return cmdSkills(rest, store);
  if (cmd === 'doctor') return cmdDoctor(store);

  if (cmd === 'ask' || cmd === 'run') {
    const flags: string[] = [];
    const words: string[] = [];
    for (const a of rest) {
      if (a.startsWith('--')) flags.push(a);
      else words.push(a);
    }
    let text = words.join(' ').trim();
    if (!text) text = await readStdin();
    if (!text) return err('请输入问题，例如：sw ask "帮我看看这个项目结构"');
    const modelFlag = flags.find((f) => f.startsWith('--model='))?.split('=')[1];
    const [pid, mid] = modelFlag ? modelFlag.split(':') : [undefined, undefined];
    return cmdAsk(text, pid, mid);
  }

  // 默认：把整条命令当作一次提问，或进入 REPL
  if (rest.length === 0 && !process.stdin.isTTY) {
    const text = cmd;
    return cmdAsk(text);
  }
  await cmdRepl();
}
