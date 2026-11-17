import { httpFetch } from '../http.js';
import type { ChatMessage, ChatRequest, ChatResult, StreamHandlers, ToolCall, ToolSchema } from './types.js';

export interface OllamaProviderOptions {
  id: string;
  /** 可以是 http://host:11434 或 http://host:11434/v1（后者会自动去掉 /v1） */
  baseURL: string;
  /** 模型常驻内存时长，避免每次对话都冷启动（14B 模型冷启动可达 10 秒） */
  keepAlive?: string | number;
}

function rootURL(base: string): string {
  return base.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function joinURL(base: string, p: string): string {
  return rootURL(base) + (p.startsWith('/') ? p : '/' + p);
}

/** OpenAI 的 arguments 是字符串，Ollama 要求是对象 */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      // Ollama 0.4+ 原生支持 tool 角色的结果回传
      return { role: 'tool', content: m.content ?? '' };
    }
    const out: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        function: {
          name: tc.function.name,
          arguments: parseArgs(tc.function.arguments),
        },
      }));
    }
    return out;
  });
}

function toOllamaTools(tools?: ToolSchema[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function buildBody(req: ChatRequest, stream: boolean, keepAlive?: string | number) {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOllamaMessages(req.messages),
    stream,
  };
  const tools = toOllamaTools(req.tools);
  if (tools) body.tools = tools;
  const options: Record<string, unknown> = {};
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
  if (Object.keys(options).length) body.options = options;
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  return body;
}

interface OllamaToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

function normalizeToolCalls(raw: OllamaToolCall[] | undefined): ToolCall[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: ToolCall[] = [];
  for (const [i, tc] of raw.entries()) {
    if (!tc?.function?.name) continue;
    const args = tc.function.arguments;
    out.push({
      id: tc.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    });
  }
  return out.length ? out : undefined;
}

function usageFrom(json: any): ChatResult['usage'] {
  if (json?.prompt_eval_count == null && json?.eval_count == null) return undefined;
  const promptTokens = json.prompt_eval_count ?? 0;
  const completionTokens = json.eval_count ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export class OllamaProvider {
  readonly id: string;
  readonly protocol = 'ollama';
  private baseURL: string;
  private keepAlive: string | number;

  constructor(opts: OllamaProviderOptions) {
    this.id = opts.id;
    this.baseURL = opts.baseURL;
    this.keepAlive = opts.keepAlive ?? '10m';
  }

  async chat(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<ChatResult> {
    const res = await httpFetch(joinURL(this.baseURL, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(req, false, this.keepAlive)),
      timeoutMs: 600000,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${text.slice(0, 600)}`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`[${this.id}] 返回不是合法 JSON：${text.slice(0, 300)}`);
    }
    const msg = json.message ?? {};
    return {
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: normalizeToolCalls(msg.tool_calls),
      },
      usage: usageFrom(json),
    };
  }

  async stream(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const res = await httpFetch(joinURL(this.baseURL, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(req, true, this.keepAlive)),
      timeoutMs: 0,
      signal: handlers.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${t.slice(0, 600)}`);
    }

    let content = '';
    const pending: ToolCall[] = [];
    let usage: ChatResult['usage'];
    let last: any = {};

    for await (const line of readNDJSON(res, handlers.signal)) {
      if (!line.trim()) continue;
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      last = json;
      const delta = json.message?.content;
      if (typeof delta === 'string' && delta) {
        content += delta;
        handlers.onText?.(delta);
      }
      if (Array.isArray(json.message?.tool_calls)) {
        // 流式下 tool_calls 一般是整块给出（或按 index 分片），这里按名字归并
        const norm = normalizeToolCalls(json.message.tool_calls) ?? [];
        for (const [i, tc] of norm.entries()) {
          if (!pending[i]) pending[i] = tc;
          else {
            if (tc.function.name) pending[i].function.name = tc.function.name;
            if (tc.function.arguments) pending[i].function.arguments = tc.function.arguments;
            if (tc.id) pending[i].id = tc.id;
          }
        }
      }
      if (json.done) {
        usage = usageFrom(json);
        break;
      }
    }

    const toolCalls = pending.length ? pending : normalizeToolCalls(last?.message?.tool_calls);
    for (const t of toolCalls ?? []) handlers.onToolCall?.(t);

    return {
      message: {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls,
      },
      usage,
    };
  }

  async listModels(): Promise<string[]> {
    const res = await httpFetch(joinURL(this.baseURL, '/api/tags'), { timeoutMs: 30000 });
    const text = await res.text();
    if (!res.ok) throw new Error(`[${this.id}] 拉取模型列表失败 HTTP ${res.status}\n${text.slice(0, 400)}`);
    try {
      const json = JSON.parse(text);
      const arr = Array.isArray(json?.models) ? json.models : [];
      return arr
        .map((m: any) => (typeof m === 'string' ? m : (m.name ?? m.model ?? '')))
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }
}

/** Ollama 流式返回是逐行 JSON（NDJSON），不是 SSE */
async function* readNDJSON(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = res.body;
  if (!body) throw new Error('响应没有 body，无法流式读取');
  const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
