import { httpFetch, readSSE } from '../http.js';
import type { ChatMessage, ChatRequest, ChatResult, StreamHandlers, ToolCall, ToolSchema } from './types.js';

export interface OpenAIProviderOptions {
  id: string;
  baseURL: string;
  apiKey: string;
  /** 额外请求头（部分中转服务需要） */
  headers?: Record<string, string>;
}

function joinURL(base: string, p: string): string {
  const b = base.replace(/\/+$/, '');
  return b + (p.startsWith('/') ? p : '/' + p);
}

function buildBody(req: ChatRequest, stream: boolean) {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
      if (m.name) out.name = m.name;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    }),
    stream,
  };
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (stream) body.stream_options = { include_usage: true };
  // max_tokens：优先使用配置值；某些推理模型要求更高上限，交给配置控制
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  return body;
}

export class OpenAICompatibleProvider {
  readonly id: string;
  readonly protocol = 'openai';
  private baseURL: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: OpenAIProviderOptions) {
    this.id = opts.id;
    this.baseURL = opts.baseURL;
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers ?? {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<ChatResult> {
    const url = joinURL(this.baseURL, '/chat/completions');
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildBody(req, false)),
      timeoutMs: 180000,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${text.slice(0, 600)}`);
    const json = JSON.parse(text);
    const choice = json.choices?.[0];
    if (!choice) throw new Error(`[${this.id}] 响应缺少 choices：${text.slice(0, 400)}`);
    const msg = choice.message ?? {};
    return {
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls ?? undefined,
        ...(msg.reasoning_content ? { name: 'reasoning' } : {}),
      },
      reasoning: msg.reasoning_content ?? msg.reasoning ?? undefined,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  }

  async stream(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const url = joinURL(this.baseURL, '/chat/completions');
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildBody(req, true)),
      timeoutMs: 0,
      signal: handlers.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${t.slice(0, 600)}`);
    }

    let content = '';
    let reasoning = '';
    const toolCalls: ToolCall[] = [];
    let usage: ChatResult['usage'];

    for await (const ev of readSSE(res, handlers.signal)) {
      if (!ev.data || ev.data === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        };
        if (!json.choices?.length) continue;
      }
      const delta = json.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        handlers.onText?.(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        handlers.onReasoning?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
          }
          const cur = toolCalls[idx];
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }

    const validToolCalls = toolCalls.filter((t) => t && t.function?.name);
    for (const t of validToolCalls) handlers.onToolCall?.(t);

    return {
      message: {
        role: 'assistant',
        content: content || null,
        tool_calls: validToolCalls.length ? validToolCalls : undefined,
      },
      reasoning: reasoning || undefined,
      usage,
    };
  }

  async listModels(): Promise<string[]> {
    const url = joinURL(this.baseURL, '/models');
    const res = await httpFetch(url, { headers: this.headers(), timeoutMs: 30000 });
    const text = await res.text();
    if (!res.ok) throw new Error(`[${this.id}] 拉取模型列表失败 HTTP ${res.status}\n${text.slice(0, 400)}`);
    try {
      const json = JSON.parse(text);
      const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      return arr
        .map((m: any) => (typeof m === 'string' ? m : (m.id ?? m.name ?? '')))
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }
}

export function openaiToolSchemas(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type { ChatMessage, ChatRequest, ChatResult };
