import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_CONFIG_DIR, globalDir, projectDir, writablePath } from './paths.js';
import { expandDeep, loadEnv } from './env.js';

export type Protocol = 'openai' | 'anthropic' | 'ollama';

export interface ModelDef {
  id: string;
  label?: string;
  context?: number;
  maxOutput?: number;
  tools?: boolean;
}

export interface ProviderDef {
  id: string;
  name: string;
  region?: 'cn' | 'intl' | 'local';
  protocol: Protocol;
  baseURL: string;
  apiKeyEnv?: string;
  apiKey?: string;
  enabled?: boolean;
  defaultModel?: string;
  docURL?: string;
  note?: string;
  /** true = 用户自己添加的（可在界面里编辑/删除） */
  custom?: boolean;
  models: ModelDef[];
}

export interface ModelsConfig {
  version: number;
  active: { provider: string; model: string };
  providers: ProviderDef[];
  /** 用户隐藏/删除的出厂供应商 id */
  hiddenProviders?: string[];
}

export interface McpServerDef {
  id: string;
  name: string;
  category?: string;
  enabled?: boolean;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  needsKey?: boolean;
  keyEnv?: string;
  requires?: string;
  homepage?: string;
  note?: string;
}

export interface McpConfig {
  version: number;
  servers: McpServerDef[];
}

export interface SkillSourceDef {
  id: string;
  name: string;
  repo: string;
  branch?: string;
  basePath?: string;
  license?: string;
  homepage?: string;
}

export interface FeaturedSkillDef {
  name: string;
  source: string;
  path: string;
  tags?: string[];
  desc?: string;
}

export interface SkillsConfig {
  version: number;
  sources: SkillSourceDef[];
  featured: FeaturedSkillDef[];
  installed?: { name: string; source?: string; installedAt?: string }[];
}

export interface ContextCompressionConfig {
  /** 是否自动压缩早期上下文 */
  enabled: boolean;
  /** 历史消息数达到该值时触发（含工具消息） */
  triggerMessages: number;
  /** 历史估算字符数达到该值时触发 */
  triggerChars: number;
  /** 至少保留的最近消息数（按安全边界取整） */
  keepRecentMessages: number;
  /** 摘要最大字符数 */
  summaryMaxChars: number;
  /** 可被压缩的早期消息少于该值时不动作，避免无意义的小摘要 */
  minOldMessages: number;
}

export const DEFAULT_CONTEXT_COMPRESSION: ContextCompressionConfig = {
  enabled: true,
  triggerMessages: 48,
  triggerChars: 32000,
  keepRecentMessages: 16,
  summaryMaxChars: 3000,
  minOldMessages: 6,
};

export interface AppConfig {
  version: number;
  agent: {
    maxTurns: number;
    temperature: number;
    maxTokens: number;
    systemPromptAppend: string;
    confirmBeforeTool: boolean;
    autoApprove: string[];
    contextCompression: ContextCompressionConfig;
  };
  tools: {
    mcpEnabled: boolean;
    mcpToolNamePrefix: string;
    commandTimeoutMs: number;
    maxOutputChars: number;
    builtin: Record<string, boolean>;
  };
  shell: {
    win32: string;
    default: string;
    windowsBashCandidates: string[];
  };
  web: { host: string; port: number; autoOpen: boolean };
  search: { provider: string; tavilyApiKeyEnv: string; braveApiKeyEnv: string };
  memory: { enabled: boolean; dir: string; injectFile: string };
  ui: { theme: string; language: string };
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`配置文件解析失败：${file}\n  ${(err as Error).message}`);
  }
}

function mergeById<T extends { id: string }>(base: T[], override: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of base) map.set(item.id, item);
  for (const item of override) {
    const prev = map.get(item.id);
    map.set(item.id, prev ? ({ ...prev, ...item } as T) : item);
  }
  return [...map.values()];
}

function mergeModels(base: ProviderDef[], override: ProviderDef[]): ProviderDef[] {
  const map = new Map<string, ProviderDef>();
  for (const p of base) map.set(p.id, p);
  for (const o of override) {
    const prev = map.get(o.id);
    if (!prev) {
      map.set(o.id, o);
    } else {
      map.set(o.id, {
        ...prev,
        ...o,
        models: mergeById(
          prev.models.map((m) => ({ ...m, id: m.id })),
          (o.models ?? []).map((m) => ({ ...m, id: m.id })),
        ) as ModelDef[],
      });
    }
  }
  return [...map.values()];
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries((override ?? {}) as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** 解析 API Key：provider.apiKey -> ${apiKeyEnv} 指向的环境变量 */
export function resolveApiKeyOf(p: ProviderDef): string {
  const fromField = (p.apiKey ?? '').trim();
  if (fromField) return fromField;
  const envName = (p.apiKeyEnv ?? '').trim();
  if (envName) return (process.env[envName] ?? '').trim();
  return '';
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** 校验并规范化一个（用户自定义）供应商定义，抛错时给出可展示的中文原因 */
export function normalizeProviderDef(input: Partial<ProviderDef>): ProviderDef {
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new Error('标识只能用小写字母、数字、点、下划线、连字符（如 my-model），长度 1-40');
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('请填写显示名称');
  const protocol = String(input.protocol ?? 'openai') as Protocol;
  if (!['openai', 'anthropic', 'ollama'].includes(protocol)) {
    throw new Error('协议只支持 openai / anthropic / ollama');
  }
  const baseURL = String(input.baseURL ?? '').trim().replace(/\/+$/, '');
  if (!baseURL) throw new Error('请填写接口地址 baseURL');
  if (!/^https?:\/\//i.test(baseURL)) throw new Error('接口地址要以 http:// 或 https:// 开头');

  const modelsRaw = Array.isArray(input.models) ? input.models : [];
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const m of modelsRaw) {
    const mid = String(m?.id ?? '').trim();
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    models.push({
      id: mid,
      label: String(m?.label ?? '').trim() || undefined,
      context: Number(m?.context) > 0 ? Number(m?.context) : undefined,
      tools: m?.tools !== false,
    });
  }
  if (!models.length) throw new Error('至少填一个模型 ID');

  return {
    id,
    name,
    region: input.region ?? (baseURL.includes('127.0.0.1') || baseURL.includes('localhost') ? 'local' : 'cn'),
    protocol,
    baseURL,
    apiKeyEnv: String(input.apiKeyEnv ?? '').trim() || undefined,
    apiKey: '',
    enabled: input.enabled !== false,
    defaultModel: String(input.defaultModel ?? '').trim() || models[0].id,
    docURL: String(input.docURL ?? '').trim() || undefined,
    note: String(input.note ?? '').trim() || undefined,
    custom: true,
    models,
  };
}

/** 依据显示名生成一个可用的 id（中文转拼音做不到，退化为 custom-xxx） */
export function suggestProviderId(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'custom';
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * 配置存储：出厂预置 < 用户级 ~/.simplework < 项目级 ./.simplework（后者覆盖前者）
 */
export class ConfigStore {
  readonly cwd: string;
  private _models?: ModelsConfig;
  private _mcp?: McpConfig;
  private _skills?: SkillsConfig;
  private _app?: AppConfig;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    loadEnv(cwd);
  }

  /** 重新从磁盘读取（Web UI 热加载用） */
  reload(): void {
    this._models = undefined;
    this._mcp = undefined;
    this._skills = undefined;
    this._app = undefined;
  }

  private layered<T>(fileName: string, merge: (base: T, over: T) => T): T {
    const builtin = path.join(BUILTIN_CONFIG_DIR, fileName);
    let result = readJson<T>(builtin);
    if (!result) throw new Error(`缺少出厂配置文件：${builtin}`);
    const globalFile = path.join(globalDir(), fileName);
    const project = projectDir(this.cwd);
    const projectFile = project ? path.join(project, fileName) : null;
    const over1 = readJson<T>(globalFile);
    if (over1) result = merge(result, over1);
    const over2 = projectFile ? readJson<T>(projectFile) : null;
    if (over2) result = merge(result, over2);
    return expandDeep(result);
  }

  get models(): ModelsConfig {
    if (!this._models) {
      this._models = this.layered<ModelsConfig>('models.json', (base, over) => {
        const hidden = [...new Set([...(base.hiddenProviders ?? []), ...(over.hiddenProviders ?? [])])];
        return {
          version: over.version ?? base.version,
          active: { ...base.active, ...(over.active ?? {}) },
          providers: mergeModels(base.providers ?? [], over.providers ?? []).filter(
            (p) => !hidden.includes(p.id),
          ),
          hiddenProviders: hidden,
        };
      });
    }
    return this._models;
  }

  get mcp(): McpConfig {
    if (!this._mcp) {
      this._mcp = this.layered<McpConfig>('mcp.json', (base, over) => ({
        version: over.version ?? base.version,
        servers: mergeById(base.servers ?? [], over.servers ?? []),
      }));
    }
    return this._mcp;
  }

  get skills(): SkillsConfig {
    if (!this._skills) {
      this._skills = this.layered<SkillsConfig>('skills.json', (base, over) => ({
        version: over.version ?? base.version,
        sources: mergeById(base.sources ?? [], over.sources ?? []),
        featured: mergeById(
          (base.featured ?? []).map((f) => ({ ...f, id: f.name })),
          (over.featured ?? []).map((f) => ({ ...f, id: f.name })),
        ).map((f) => {
          const { id: _id, ...rest } = f as FeaturedSkillDef & { id: string };
          return rest;
        }),
        installed: [...(base.installed ?? []), ...(over.installed ?? [])],
      }));
    }
    return this._skills;
  }

  get app(): AppConfig {
    if (!this._app) {
      this._app = this.layered<AppConfig>('config.json', (base, over) => deepMerge(base, over));
      // 老版本配置没有这一节时，补齐默认值（也防止手写配置把它设为 null）
      this._app.agent = {
        ...this._app.agent,
        contextCompression: {
          ...DEFAULT_CONTEXT_COMPRESSION,
          ...(this._app.agent?.contextCompression ?? {}),
        },
      };
    }
    return this._app;
  }

  save(fileName: string, data: unknown): string {
    const target = writablePath(fileName, this.cwd);
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
    this.reload();
    return target;
  }

  saveModels(data: ModelsConfig): string {
    return this.save('models.json', data);
  }

  saveMcp(data: McpConfig): string {
    return this.save('mcp.json', data);
  }

  saveSkills(data: SkillsConfig): string {
    return this.save('skills.json', data);
  }

  saveApp(data: AppConfig): string {
    return this.save('config.json', data);
  }

  provider(id?: string): ProviderDef {
    const pid = id ?? this.models.active.provider;
    const p = this.models.providers.find((x) => x.id === pid);
    if (!p) throw new Error(`未找到模型供应商：${pid}`);
    return p;
  }

  /** 当前生效的 provider + model */
  activeSpec(): { provider: ProviderDef; model: string } {
    const provider = this.provider();
    const model = this.models.active.model || provider.defaultModel || provider.models[0]?.id;
    if (!model) throw new Error(`供应商 ${provider.id} 没有可用模型`);
    return { provider, model };
  }

  /** 解析 API Key：provider.apiKey -> ${apiKeyEnv} 指向的环境变量 */
  resolveApiKey(p: ProviderDef): string {
    return resolveApiKeyOf(p);
  }

  /** 当前全部供应商（已过滤被隐藏的） */
  allProviders(): ProviderDef[] {
    return this.models.providers;
  }

  /** 新增或更新一个供应商；返回写盘路径 */
  upsertProvider(def: ProviderDef, opts: { activate?: boolean } = {}): { file: string; created: boolean } {
    const cfg = JSON.parse(JSON.stringify(this.models)) as ModelsConfig;
    const idx = cfg.providers.findIndex((x) => x.id === def.id);
    const created = idx < 0;
    // apiKey 不落 models.json（统一走 .env），避免密钥散落在配置里
    const stored: ProviderDef = { ...def, apiKey: undefined };
    if (created) cfg.providers.push(stored);
    else cfg.providers[idx] = { ...cfg.providers[idx], ...stored };
    // 若之前被隐藏过，取消隐藏
    cfg.hiddenProviders = (cfg.hiddenProviders ?? []).filter((x) => x !== def.id);
    if (opts.activate || !cfg.providers.some((p) => p.id === cfg.active.provider)) {
      cfg.active = { provider: def.id, model: stored.defaultModel || def.models[0]?.id || '' };
    }
    const file = this.saveModels(cfg);
    return { file, created };
  }

  /** 删除供应商：自定义的直接移除，出厂的加入隐藏列表 */
  removeProvider(id: string): { file: string; hidden: boolean } {
    const cfg = JSON.parse(JSON.stringify(this.models)) as ModelsConfig;
    const target = cfg.providers.find((x) => x.id === id);
    if (!target) throw new Error(`未找到模型供应商：${id}`);
    let hidden = false;
    if (target.custom) {
      cfg.providers = cfg.providers.filter((x) => x.id !== id);
    } else {
      hidden = true;
      cfg.providers = cfg.providers.filter((x) => x.id !== id);
      cfg.hiddenProviders = [...new Set([...(cfg.hiddenProviders ?? []), id])];
    }
    if (cfg.active.provider === id) {
      const next =
        cfg.providers.find((p) => p.enabled !== false && resolveApiKeyOf(p)) ??
        cfg.providers.find((p) => p.enabled !== false) ??
        cfg.providers[0];
      cfg.active = { provider: next?.id ?? '', model: next?.defaultModel ?? next?.models[0]?.id ?? '' };
    }
    const file = this.saveModels(cfg);
    return { file, hidden };
  }

  setActive(providerId: string, modelId?: string): void {
    const cfg = JSON.parse(JSON.stringify(this.models)) as ModelsConfig;
    const p = cfg.providers.find((x) => x.id === providerId);
    if (!p) throw new Error(`未找到模型供应商：${providerId}`);
    cfg.active.provider = providerId;
    cfg.active.model = modelId || p.defaultModel || p.models[0]?.id || '';
    this.saveModels(cfg);
  }
}
