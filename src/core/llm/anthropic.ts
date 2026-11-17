import { httpFetch, readSSE } from '../http.js';
import type { ChatMessage, ChatRequest, ChatResult, StreamHandlers, ToolCall } from './types.js';

export interface AnthropicProviderOptions {
  id: string;
  baseURL: string;
  apiKey: string;
}

function joinURL(base: string, p: string): string {
  const b = base.replace(/\/+$/, '');
  return b + (p.startsWith('/') ? p : '/' + p);
}

/** 把 OpenAI 风格消息转成 Anthropic Messages API 格式 */
function convert(messages: ChatMessage[]): { system: string; msgs: any[] } {
  const systemParts: string[] = [];
  const msgs: any[] = [];
  let pendingToolResults: any[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      msgs.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content ?? '');
      continue;
    }
    if (m.role === 'user') {
      flushToolResults();
      msgs.push({ role: 'user', content: [{ type: 'text', text: m.content ?? '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      flushToolResults();
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
      }
      if (!content.length) content.push({ type: 'text', text: '' });
      msgs.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content ?? '',
      });
      continue;
    }
  }
  flushToolResults();

  // Anthropic 要求首条必须是 user
  const filtered = msgs.filter((m, i) => !(i === 0 && m.role !== 'user'));
  return { system: systemParts.join('\n\n'), msgs: filtered };
}

export class AnthropicProvider {
  readonly id: string;
  readonly protocol = 'anthropic';
  private baseURL: string;
  private apiKey: string;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id;
    this.baseURL = opts.baseURL;
    this.apiKey = opts.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.apiKey,
    };
  }

  private body(req: ChatRequest, stream: boolean) {
    const { system, msgs } = convert(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: msgs,
      stream,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    return body;
  }

  private parseContent(content: any[]): ChatResult {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content ?? []) {
      if (block?.type === 'text') text += block.text ?? '';
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    return {
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
    };
  }

  async chat(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<ChatResult> {
    const url = joinURL(this.baseURL, '/messages');
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, false)),
      timeoutMs: 180000,
      signal: opts.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${text.slice(0, 600)}`);
    const json = JSON.parse(text);
    const result = this.parseContent(json.content);
    result.usage = json.usage
      ? {
          promptTokens: json.usage.input_tokens,
          completionTokens: json.usage.output_tokens,
          totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
        }
      : undefined;
    return result;
  }

  async stream(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const url = joinURL(this.baseURL, '/messages');
    const res = await httpFetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, true)),
      timeoutMs: 0,
      signal: handlers.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`[${this.id}] HTTP ${res.status} ${res.statusText}\n${t.slice(0, 600)}`);
    }

    interface Block {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      json?: string;
    }
    const blocks = new Map<number, Block>();
    let usage: ChatResult['usage'];

    for await (const ev of readSSE(res, handlers.signal)) {
      if (!ev.data) continue;
      let json: any;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = json.type;
      if (type === 'content_block_start') {
        blocks.set(json.index, { type: json.content_block?.type ?? '', ...json.content_block });
      } else if (type === 'content_block_delta') {
        const b = blocks.get(json.index) ?? { type: '' };
        const d = json.delta ?? {};
        if (d.type === 'text_delta') {
          b.text = (b.text ?? '') + (d.text ?? '');
          handlers.onText?.(d.text ?? '');
        } else if (d.type === 'input_json_delta') {
          b.json = (b.json ?? '') + (d.partial_json ?? '');
        } else if (d.type === 'thinking_delta') {
          handlers.onReasoning?.(d.thinking ?? '');
        }
        blocks.set(json.index, b);
      } else if (type === 'message_delta') {
        if (json.usage) {
          usage = {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
          };
        }
      } else if (type === 'error') {
        throw new Error(`[${this.id}] ${json.error?.message ?? '流式响应出错'}`);
      }
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const b of [...blocks.values()]) {
      if (b.type === 'text' && b.text) content += b.text;
      if (b.type === 'tool_use' && b.name) {
        toolCalls.push({
          id: b.id ?? `tool_${toolCalls.length}`,
          type: 'function',
          function: { name: b.name, arguments: b.json && b.json.trim() ? b.json : '{}' },
        });
      }
    }
    for (const t of toolCalls) handlers.onToolCall?.(t);

    return {
      message: {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
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
      const arr = Array.isArray(json?.data) ? json.data : [];
      return arr.map((m: any) => m.id ?? m.name).filter(Boolean).sort();
    } catch {
      return [];
    }
  }
}
