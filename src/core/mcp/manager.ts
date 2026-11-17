import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerDef } from '../config.js';
import { expandString } from '../env.js';
import type { ToolSchema } from '../llm/types.js';

export interface McpStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
}

interface Entry {
  def: McpServerDef;
  client: Client;
  tools: { full: string; raw: string; schema: ToolSchema }[];
  connected: boolean;
  error?: string;
}

const SHELL_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'uvx', 'uv']);

/** Windows 上 npx.cmd / uvx 这类 .cmd 无法直接 spawn，需要用 cmd.exe 包一层 */
function normalizeCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args };
  const base = path.basename(command).toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
  if (SHELL_COMMANDS.has(base) || SHELL_COMMANDS.has(command.toLowerCase())) {
    return { command: 'cmd.exe', args: ['/c', command, ...args] };
  }
  return { command, args };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class McpManager {
  private entries = new Map<string, Entry>();
  private byFullName = new Map<string, { serverId: string; raw: string }>();
  readonly prefix: string;

  constructor(prefix = 'mcp__') {
    this.prefix = prefix;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 连接所有 enabled 的 MCP 服务器（失败不影响其它） */
  async connectAll(servers: McpServerDef[], cwd: string, timeoutMs = 30000): Promise<McpStatus[]> {
    const targets = servers.filter((s) => s.enabled !== false);
    const results = await Promise.all(targets.map((s) => this.connect(s, cwd, timeoutMs)));
    return results;
  }

  async connect(def: McpServerDef, cwd: string, timeoutMs = 30000): Promise<McpStatus> {
    const base: McpStatus = {
      id: def.id,
      name: def.name,
      enabled: true,
      transport: def.transport ?? 'stdio',
      connected: false,
      toolCount: 0,
      tools: [],
    };
    try {
      const client = new Client({ name: 'SimpleWork', version: '0.1.0' }, { capabilities: {} });
      let transport;
      if ((def.transport ?? 'stdio') === 'stdio') {
        if (!def.command) throw new Error('缺少 command 配置');
        const { command, args } = normalizeCommand(def.command, (def.args ?? []).map((a) => expandString(String(a)).replace('{{WORKSPACE}}', cwd)));
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        for (const [k, v] of Object.entries(def.env ?? {})) {
          env[k] = expandString(String(v));
        }
        transport = new StdioClientTransport({
          command,
          args,
          env,
          stderr: 'pipe',
        } as ConstructorParameters<typeof StdioClientTransport>[0]);
      } else if (def.transport === 'http') {
        if (!def.url) throw new Error('缺少 url 配置');
        transport = new StreamableHTTPClientTransport(new URL(expandString(def.url)), {
          requestInit: { headers: expandHeaders(def.headers) },
        });
      } else {
        if (!def.url) throw new Error('缺少 url 配置');
        transport = new SSEClientTransport(new URL(expandString(def.url)), {
          requestInit: { headers: expandHeaders(def.headers) },
        });
      }

      await withTimeout(client.connect(transport), timeoutMs, `连接 ${def.id}`);
      const listed = await withTimeout(client.listTools(), 20000, `列出工具 ${def.id}`);
      const tools = (listed.tools ?? []).map((t) => {
        const full = `${this.prefix}${def.id}__${t.name}`;
        return {
          full,
          raw: t.name,
          schema: {
            name: full,
            description: `[MCP:${def.name}] ${t.description ?? t.name}`,
            parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as ToolSchema['parameters'],
          },
        };
      });
      const entry: Entry = { def, client, tools, connected: true };
      this.entries.set(def.id, entry);
      for (const t of tools) this.byFullName.set(t.full, { serverId: def.id, raw: t.raw });
      return { ...base, connected: true, toolCount: tools.length, tools: tools.map((t) => t.raw) };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { ...base, connected: false, error: message };
    }
  }

  schemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const e of this.entries.values()) {
      if (!e.connected) continue;
      for (const t of e.tools) out.push(t.schema);
    }
    return out;
  }

  status(): McpStatus[] {
    return [...this.entries.values()].map((e) => ({
      id: e.def.id,
      name: e.def.name,
      enabled: true,
      transport: e.def.transport ?? 'stdio',
      connected: e.connected,
      toolCount: e.tools.length,
      tools: e.tools.map((t) => t.raw),
      error: e.error,
    }));
  }

  has(fullName: string): boolean {
    return this.byFullName.has(fullName);
  }

  async call(fullName: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<string> {
    const ref = this.byFullName.get(fullName);
    if (!ref) throw new Error(`未注册的 MCP 工具：${fullName}`);
    const entry = this.entries.get(ref.serverId);
    if (!entry) throw new Error(`MCP 服务器未连接：${ref.serverId}`);
    const res = (await withTimeout(
      entry.client.callTool({ name: ref.raw, arguments: args }),
      timeoutMs,
      `调用 ${fullName}`,
    )) as { content?: { type: string; text?: string; resource?: unknown }[]; isError?: boolean };
    const parts: string[] = [];
    for (const c of res.content ?? []) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'resource') parts.push(JSON.stringify(c.resource));
      else parts.push(JSON.stringify(c));
    }
    const text = parts.join('\n') || '（工具无输出）';
    return res.isError ? `MCP 工具返回错误：\n${text}` : text;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (e) => {
        try {
          await e.client.close();
        } catch {
          /* ignore */
        }
      }),
    );
    this.entries.clear();
    this.byFullName.clear();
  }
}

function expandHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = expandString(String(v));
  return out;
}
