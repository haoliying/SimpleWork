import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../core/session.js';
import { ConfigStore, normalizeProviderDef, suggestProviderId } from '../core/config.js';
import type { ProviderDef } from '../core/config.js';
import { createProviderFromDef } from '../core/llm/index.js';
import { SkillRegistry } from '../core/skills/loader.js';
import { installSkill, removeSkill, searchRemote } from '../core/skills/installer.js';
import { ConversationStore, autoTitle } from '../core/conversations.js';
import { sanitizeHistory } from '../core/history.js';
import type { Conversation, ConvToolCall } from '../core/conversations.js';
import { INSTALL_DIR, ensureDir, globalDir } from '../core/paths.js';
import { writeEnvVar } from '../core/env.js';
import type { Agent } from '../core/agent.js';

export interface WebServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  open?: boolean;
  /** 是否在进程内接管 SIGINT/SIGTERM（CLI 用 true，桌面壳自己管理生命周期） */
  handleSignals?: boolean;
  /** MCP 连接策略：'wait' 等全部连上再启动，'background' 先起界面后连（桌面默认），false 不连 */
  mcp?: 'wait' | 'background' | false;
  /** 状态日志回调（桌面版写进控制台/日志文件） */
  onStatus?: (line: string) => void;
}

export interface WebHandle {
  url: string;
  port: number;
  cwd: string;
  close: () => Promise<void>;
}

function locateUI(): string {
  const candidates = [
    path.join(INSTALL_DIR, 'web', 'public', 'index.html'),
    path.join(INSTALL_DIR, 'src', 'web', 'public', 'index.html'),
    path.join(INSTALL_DIR, 'dist', 'web', 'public', 'index.html'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`找不到 Web 界面文件：${candidates.join(' / ')}`);
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startWebServer(opts: WebServerOptions = {}): Promise<WebHandle> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  ensureDir(globalDir());
  const store = new ConfigStore(cwd);
  const skills = new SkillRegistry(cwd);
  const convStore = new ConversationStore();
  const uiFile = locateUI();
  const log = opts.onStatus ?? ((line: string) => console.log(`  ${line}`));

  // 先建会话（不连 MCP），让界面能立刻打开；MCP 随后在后台连接
  const session = await Session.create({ cwd, connectMcp: false });

  /** 每个会话一个 Agent（各自持有上下文），共享 MCP / Skill / 配置 */
  const agents = new Map<string, Agent>();
  const agentFor = (id: string): Agent => {
    let a = agents.get(id);
    if (!a) {
      a = session.spawnAgent();
      agents.set(id, a);
    }
    return a;
  };
  let currentConvId: string | null = null;

  const port = opts.port ?? store.app.web.port ?? 8787;
  const host = opts.host ?? store.app.web.host ?? '127.0.0.1';

  const send = (res: http.ServerResponse, event: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const route = url.pathname;

    try {
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        const html = fs.readFileSync(uiFile, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && route === '/api/state') {
        const mcpLive = session.mcp.status();
        json(res, {
          cwd,
          globalDir: globalDir(),
          active: store.models.active,
          providers: store.models.providers.map((p) => ({
            id: p.id,
            name: p.name,
            region: p.region,
            protocol: p.protocol,
            baseURL: p.baseURL,
            hasKey: Boolean(store.resolveApiKey(p)),
            apiKeyEnv: p.apiKeyEnv,
            docURL: p.docURL,
            note: p.note,
            custom: Boolean(p.custom),
            defaultModel: p.defaultModel,
            models: p.models.map((m) => ({ id: m.id, label: m.label, context: m.context, tools: m.tools })),
          })),
          mcp: mcpLive.length ? mcpLive : session.mcpStatus,
          mcpAll: store.mcp.servers.map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            enabled: s.enabled !== false,
            needsKey: Boolean(s.needsKey),
            keyEnv: s.keyEnv,
            hasKey: s.keyEnv ? Boolean(process.env[s.keyEnv]) : true,
            note: s.note,
            tools: (mcpLive.find((x) => x.id === s.id)?.tools ?? []) as string[],
          })),
          skills: skills.list().map((s) => ({
            name: s.name,
            description: s.description,
            scope: s.scope,
          })),
          config: store.app,
        });
        return;
      }

      // ---------- 会话（历史对话 + 上下文持久化） ----------
      if (req.method === 'GET' && route === '/api/conversations') {
        return json(res, {
          conversations: convStore.list(),
          currentId: currentConvId,
          dir: convStore.dir,
        });
      }

      if (req.method === 'GET' && route === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'all';
        const hits = convStore.search(q, {
          conversationId: scope === 'current' ? (currentConvId ?? undefined) : undefined,
        });
        return json(res, {
          q,
          scope,
          hits: hits.map((h) => ({
            id: h.id,
            title: h.title,
            updatedAt: h.updatedAt,
            total: h.total,
            matches: h.matches.map((m) => ({
              role: m.role,
              ts: m.ts,
              index: m.index,
              snippet: (m.truncatedStart ? '…' : '') + m.snippet + (m.truncatedEnd ? '…' : ''),
            })),
          })),
        });
      }

      if (req.method === 'POST' && route === '/api/conversations') {
        const { title, provider, model } = JSON.parse((await readBody(req)) || '{}') as {
          title?: string;
          provider?: string;
          model?: string;
        };
        const conv = convStore.create(title ?? '新对话', provider, model);
        currentConvId = conv.id;
        return json(res, { ok: true, conversation: conv });
      }

      if (route.startsWith('/api/conversations/')) {
        const id = route.slice('/api/conversations/'.length).split('/')[0];
        if (req.method === 'GET') {
          const conv = convStore.get(id);
          if (!conv) return json(res, { error: '会话不存在' }, 404);
          currentConvId = id;
          return json(res, { conversation: conv });
        }
        if (req.method === 'DELETE') {
          convStore.remove(id);
          agents.delete(id);
          if (currentConvId === id) currentConvId = null;
          return json(res, { ok: true });
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            title?: string;
            action?: string;
          };
          if (body.action === 'clear') {
            convStore.clear(id);
            const a = agents.get(id);
            if (a) a.clear();
            return json(res, { ok: true });
          }
          convStore.rename(id, body.title ?? '');
          return json(res, { ok: true });
        }
      }

      if (req.method === 'POST' && route === '/api/chat') {
        const raw = await readBody(req);
        const { message, provider, model, conversationId } = JSON.parse(raw || '{}') as {
          message?: string;
          provider?: string;
          model?: string;
          conversationId?: string;
        };
        if (!message) return json(res, { error: '缺少 message' }, 400);

        // 定位会话：显式指定 > 当前 > 新建
        let conv: Conversation | null = conversationId
          ? convStore.get(conversationId)
          : currentConvId
            ? convStore.get(currentConvId)
            : null;
        if (!conv) conv = convStore.create();
        currentConvId = conv.id;

        const agent = agentFor(conv.id);
        // 恢复该会话的历史上下文
        agent.history = conv.history.slice();
        if (provider) {
          agent.setModel(provider, model);
          conv.provider = provider;
          conv.model = model ?? undefined;
        }
        if (conv.messages.length === 0) conv.title = autoTitle(message);
        conv.messages.push({ role: 'user', text: message, ts: Date.now() });
        convStore.save(conv); // 先落盘：即使中途崩溃也不丢用户输入

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        send(res, { type: 'conversation', id: conv.id, title: conv.title });

        // 前端关掉页面 / 点停止 → 中止本轮，并把已有内容存下来
        const ac = new AbortController();
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableEnded) {
            clientGone = true;
            ac.abort();
          }
        });

        const tools: ConvToolCall[] = [];
        let pending: { name: string; args: string } | null = null;
        let finalText = '';
        let lastError = '';

        try {
          finalText = await agent.run(message, {
            signal: ac.signal,
            onText: (delta) => send(res, { type: 'text', delta }),
            onReasoning: (delta) => send(res, { type: 'reasoning', delta }),
            onToolStart: (name, args) => {
              pending = { name, args: JSON.stringify(args ?? {}) };
              send(res, { type: 'tool_start', name, args });
            },
            onToolEnd: (name, result, okFlag, ms) => {
              tools.push({
                name,
                args: pending?.args ?? '',
                result: (result ?? '').slice(0, 4000),
                ok: okFlag,
                durationMs: ms,
              });
              pending = null;
              send(res, {
                type: 'tool_end',
                name,
                result: result.slice(0, 4000),
                ok: okFlag,
                durationMs: ms,
              });
            },
            onError: (message2) => {
              lastError = message2;
              send(res, { type: 'error', message: message2 });
            },
          });
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (!clientGone) {
            lastError = msg;
            send(res, { type: 'error', message: msg });
          } else {
            lastError = `已中断（${msg}）`;
          }
        }

        // 落盘：上下文 + 展示消息
        conv.history = sanitizeHistory(agent.history.slice());
        conv.messages.push({
          role: 'assistant',
          text: finalText,
          ts: Date.now(),
          tools: tools.length ? tools : undefined,
          error: lastError || undefined,
          provider: conv.provider,
          model: conv.model,
        });
        convStore.save(conv);
        if (!clientGone) {
          send(res, { type: 'done', id: conv.id, title: conv.title });
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && route === '/api/clear') {
        const { conversationId } = JSON.parse((await readBody(req)) || '{}') as {
          conversationId?: string;
        };
        const id = conversationId ?? currentConvId;
        if (id) {
          convStore.clear(id);
          const a = agents.get(id);
          if (a) a.clear();
        }
        session.agent.clear();
        return json(res, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/models/use') {
        const { provider, model } = JSON.parse((await readBody(req)) || '{}') as {
          provider?: string;
          model?: string;
        };
        if (!provider) return json(res, { error: '缺少 provider' }, 400);
        store.setActive(provider, model);
        session.agent.setModel(provider, model);
        if (currentConvId) {
          const a = agents.get(currentConvId);
          if (a) a.setModel(provider, model);
          const c = convStore.get(currentConvId);
          if (c) {
            c.provider = provider;
            c.model = model ?? undefined;
            convStore.save(c);
          }
        }
        return json(res, { ok: true });
      }

      // ---------- 自定义模型供应商 ----------
      if (req.method === 'POST' && route === '/api/providers') {
        const body = JSON.parse((await readBody(req)) || '{}') as Partial<ProviderDef> & {
          apiKey?: string;
          activate?: boolean;
        };
        try {
          if (!body.id && body.name) {
            body.id = suggestProviderId(body.name, store.models.providers.map((p) => p.id));
          }
          const def = normalizeProviderDef(body);
          // 明文 Key 一律写进 .env（不落 models.json），并记住变量名
          const rawKey = String(body.apiKey ?? '').trim();
          if (rawKey) {
            const envName =
              String(body.apiKeyEnv ?? '').trim() || `${def.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
            writeEnvVar(path.join(globalDir(), '.env'), envName, rawKey);
            def.apiKeyEnv = envName;
          }
          const r = store.upsertProvider(def, { activate: body.activate !== false });
          log(`模型供应商已保存：${def.id}（${def.name}，${def.protocol}）`);
          return json(res, { ok: true, created: r.created, file: r.file, id: def.id });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      }

      if (req.method === 'DELETE' && route.startsWith('/api/providers/')) {
        const id = decodeURIComponent(route.slice('/api/providers/'.length).split('/')[0]);
        if (!id) return json(res, { error: '缺少 id' }, 400);
        try {
          const r = store.removeProvider(id);
          log(`模型供应商已删除：${id}`);
          return json(res, { ok: true, hidden: r.hidden, file: r.file });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      }

      // 测试连通性 / 在线拉取模型列表（可传已保存的 id，也可传一份还没保存的 def）
      if (req.method === 'POST' && route === '/api/providers/test') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          id?: string;
          def?: Partial<ProviderDef>;
          mode?: 'chat' | 'models';
          model?: string;
          apiKey?: string;
        };
        try {
          let def: ProviderDef;
          if (body.def && !body.id) {
            def = normalizeProviderDef(body.def);
          } else {
            def = store.provider(body.id);
          }
          // 未保存的明文 Key 只在本次请求里生效
          if (body.apiKey) def = { ...def, apiKey: String(body.apiKey).trim() };
          const { provider, model, missingKeyEnv } = createProviderFromDef(def, body.model);
          if (body.mode === 'models') {
            const models = await provider.listModels();
            return json(res, { ok: true, models });
          }
          const started = Date.now();
          const out = await provider.chat({
            model,
            messages: [
              { role: 'system', content: '你是一个简洁的助手。' },
              { role: 'user', content: '只回复两个字：正常' },
            ],
            temperature: 0,
            maxTokens: 32,
          });
          return json(res, {
            ok: true,
            ms: Date.now() - started,
            model,
            reply: (out.message.content ?? '').trim() || '（空回复）',
            missingKeyEnv,
          });
        } catch (e) {
          return json(res, { error: (e as Error).message });
        }
      }

      // 在应用内直接保存 API Key（写入 ~/.simplework/.env）
      if (req.method === 'POST' && route === '/api/env') {
        const { key, value } = JSON.parse((await readBody(req)) || '{}') as {
          key?: string;
          value?: string;
        };
        if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return json(res, { error: '非法的环境变量名' }, 400);
        }
        const file = path.join(globalDir(), '.env');
        writeEnvVar(file, key, String(value ?? '').trim());
        store.reload();
        return json(res, { ok: true, file, hasKey: Boolean(process.env[key]) });
      }

      if (req.method === 'POST' && route === '/api/mcp/toggle') {
        const { id, enabled } = JSON.parse((await readBody(req)) || '{}') as {
          id?: string;
          enabled?: boolean;
        };
        if (!id) return json(res, { error: '缺少 id' }, 400);
        const cfg = JSON.parse(JSON.stringify(store.mcp)) as typeof store.mcp;
        cfg.servers = cfg.servers.map((s) => (s.id === id ? { ...s, enabled: Boolean(enabled) } : s));
        store.saveMcp(cfg);
        // 立即连接或断开
        if (enabled) {
          const def = store.mcp.servers.find((s) => s.id === id);
          if (def) {
            const st = await session.mcp.connect(def, cwd, 45000);
            session.mcpStatus = [...session.mcpStatus.filter((x) => x.id !== id), st];
            log(st.connected ? `MCP ${id} 已连接（${st.toolCount} 工具）` : `MCP ${id} 失败：${st.error}`);
            return json(res, { ok: true, status: st });
          }
        }
        return json(res, { ok: true });
      }

      if (req.method === 'GET' && route === '/api/skills/search') {
        const q = url.searchParams.get('q') ?? '';
        const outcome = await searchRemote(store, q, cwd);
        return json(res, { hits: outcome.hits.slice(0, 60), onlineError: outcome.onlineError });
      }

      if (req.method === 'POST' && route === '/api/skills/install') {
        const { spec } = JSON.parse((await readBody(req)) || '{}') as { spec?: string };
        if (!spec) return json(res, { error: '缺少 spec' }, 400);
        const r = await installSkill(store, spec, { cwd });
        skills.reload();
        return json(res, { ok: true, name: r.name, dir: r.dir });
      }

      if (req.method === 'POST' && route === '/api/skills/remove') {
        const { name } = JSON.parse((await readBody(req)) || '{}') as { name?: string };
        if (!name) return json(res, { error: '缺少 name' }, 400);
        removeSkill(store, name, cwd);
        skills.reload();
        return json(res, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/reload') {
        store.reload();
        skills.reload();
        return json(res, { ok: true });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (e) {
      if (!res.headersSent) {
        json(res, { error: (e as Error).message }, 500);
      } else {
        try {
          send(res, { type: 'error', message: (e as Error).message });
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  const url = `http://${host}:${actualPort}`;

  // MCP：桌面版后台连接，CLI 等待
  const connectMcp = opts.mcp ?? 'wait';
  if (connectMcp) {
    const runConnect = async () => {
      const statuses = await session.mcp.connectAll(store.mcp.servers, cwd, 45000);
      session.mcpStatus = statuses;
      for (const s of statuses) {
        log(s.connected ? `MCP ${s.id} 已连接（${s.toolCount} 工具）` : `MCP ${s.id} 失败：${s.error}`);
      }
    };
    if (connectMcp === 'wait') await runConnect();
    else void runConnect();
  }

  const close = async (): Promise<void> => {
    await session.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  if (opts.handleSignals) {
    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  if (opts.open ?? store.app.web.autoOpen) {
    const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const { spawn } = await import('node:child_process');
      spawn(openCmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    } catch {
      /* ignore */
    }
  }

  return { url, port: actualPort, cwd, close };
}
