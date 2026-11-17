import type { ConfigStore } from './config.js';
import { createProvider } from './llm/index.js';
import type { ChatMessage, ToolSchema } from './llm/types.js';
import { builtinTools } from './tools/builtin.js';
import type { Tool, ToolContext, ToolResult } from './tools/types.js';
import type { McpManager } from './mcp/manager.js';
import type { SkillRegistry } from './skills/loader.js';
import { buildSystemPrompt } from './prompt.js';
import { sanitizeHistory } from './history.js';

export interface AgentEvents {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, ok: boolean, durationMs: number) => void;
  onTurn?: (turn: number) => void;
  onError?: (message: string) => void;
  /** 需要人工确认的工具；返回 false 表示拒绝执行 */
  onConfirm?: (name: string, args: Record<string, unknown>) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

export interface AgentOptions {
  cwd: string;
  store: ConfigStore;
  skills: SkillRegistry;
  mcp: McpManager;
  providerId?: string;
  modelId?: string;
}

const MAX_HISTORY_MESSAGES = 80;

export class Agent {
  readonly cwd: string;
  readonly store: ConfigStore;
  readonly skills: SkillRegistry;
  readonly mcp: McpManager;
  history: ChatMessage[] = [];
  private providerId?: string;
  private modelId?: string;

  constructor(opts: AgentOptions) {
    this.cwd = opts.cwd;
    this.store = opts.store;
    this.skills = opts.skills;
    this.mcp = opts.mcp;
    this.providerId = opts.providerId;
    this.modelId = opts.modelId;
  }

  clear(): void {
    this.history = [];
  }

  /** 运行时切换模型 */
  setModel(providerId?: string, modelId?: string): void {
    this.providerId = providerId;
    this.modelId = modelId;
  }

  currentModel(): { providerId?: string; modelId?: string } {
    return { providerId: this.providerId, modelId: this.modelId };
  }

  private enabledBuiltinTools(): Tool[] {
    const builtinCfg = this.store.app.tools.builtin ?? {};
    return builtinTools.filter((t) => builtinCfg[t.name] !== false);
  }

  toolSchemas(): ToolSchema[] {
    const builtin = this.enabledBuiltinTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const mcp = this.store.app.tools.mcpEnabled ? this.mcp.schemas() : [];
    return [...builtin, ...mcp];
  }

  private systemPrompt(): string {
    return buildSystemPrompt({
      cwd: this.cwd,
      store: this.store,
      skills: this.skills,
      mcpTools: this.store.app.tools.mcpEnabled ? this.mcp.schemas() : [],
      builtinToolNames: this.enabledBuiltinTools().map((t) => t.name),
      model: this.modelId ?? this.store.models.active.model,
      providerName: this.store.provider(this.providerId).name,
    });
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    events: AgentEvents,
  ): Promise<ToolResult> {
    const builtin = this.enabledBuiltinTools().find((t) => t.name === name);
    const ctx: ToolContext = {
      cwd: this.cwd,
      store: this.store,
      skills: this.skills,
      signal: events.signal,
    };
    const started = Date.now();
    events.onToolStart?.(name, args);
    try {
      let result: ToolResult;
      if (builtin) {
        result = await builtin.execute(args, ctx);
      } else if (this.mcp.has(name)) {
        const text = await this.mcp.call(name, args);
        result = { content: text };
      } else {
        result = { content: `未知工具：${name}`, isError: true };
      }
      const durationMs = Date.now() - started;
      events.onToolEnd?.(name, result.content, !result.isError, durationMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = (err as Error).message ?? String(err);
      events.onToolEnd?.(name, message, false, durationMs);
      return { content: `工具执行异常：${message}`, isError: true };
    }
  }

  /** 运行一轮对话（含工具循环），返回最终文本 */
  async run(userInput: string, events: AgentEvents = {}): Promise<string> {
    const { provider, def, model, missingKeyEnv } = createProvider(this.store, this.providerId, this.modelId);
    if (missingKeyEnv && def.protocol !== 'openai') {
      throw new Error(`缺少 API Key：请在 ~/.simplework/.env 中设置 ${missingKeyEnv}（供应商 ${def.id}）`);
    }
    if (missingKeyEnv && !def.baseURL.includes('127.0.0.1') && !def.baseURL.includes('localhost')) {
      events.onError?.(
        `提示：${def.name} 未配置密钥（${missingKeyEnv}）。若该服务无需密钥可忽略，否则请在 ~/.simplework/.env 中填写。`,
      );
    }

    this.history.push({ role: 'user', content: userInput });
    const system = this.systemPrompt();
    const maxTurns = this.store.app.agent.maxTurns ?? 40;
    let finalText = '';

    for (let turn = 1; turn <= maxTurns; turn++) {
      events.onTurn?.(turn);
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...this.trimHistory(),
      ];

      const collectedToolCalls: ChatMessage['tool_calls'] = [];
      let streamed = '';
      const result = await provider.stream(
        {
          model,
          messages,
          tools: this.toolSchemas(),
          temperature: this.store.app.agent.temperature,
          maxTokens: this.store.app.agent.maxTokens,
        },
        {
          signal: events.signal,
          onText: (delta) => {
            streamed += delta;
            events.onText?.(delta);
          },
          onReasoning: (delta) => events.onReasoning?.(delta),
          onToolCall: (tc) => {
            if (!collectedToolCalls) return;
            const existing = collectedToolCalls.find((x) => x.id === tc.id);
            if (existing) existing.function = tc.function;
            else collectedToolCalls.push(tc);
          },
        },
      );

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.message.content ?? (streamed || null),
        tool_calls: result.message.tool_calls?.length ? result.message.tool_calls : undefined,
      };
      this.history.push(assistantMsg);
      if (assistantMsg.content) finalText = assistantMsg.content;

      const calls = assistantMsg.tool_calls;
      if (!calls || !calls.length) break;

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }

        // 人工确认（若开启且工具不在自动放行名单）
        const auto = this.store.app.agent.autoApprove ?? [];
        if (this.store.app.agent.confirmBeforeTool && !auto.includes(call.function.name) && events.onConfirm) {
          const ok = await events.onConfirm(call.function.name, args);
          if (!ok) {
            this.history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: '用户拒绝了本次工具调用。',
            });
            continue;
          }
        }

        const res = await this.executeTool(call.function.name, args, events);
        const maxChars = this.store.app.tools.maxOutputChars ?? 20000;
        const content =
          res.content && res.content.length > maxChars
            ? `${res.content.slice(0, maxChars)}\n...[输出过长已截断]`
            : res.content || '（工具无输出）';
        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: res.isError ? `错误：${content}` : content,
        });
      }

      if (events.signal?.aborted) break;
    }

    // 中断可能留下不完整的工具轮次，落盘/下一轮前修一下
    this.history = sanitizeHistory(this.history);
    return finalText;
  }

  /** 简单的历史裁剪，避免无限膨胀 */
  private trimHistory(): ChatMessage[] {
    const msgs = this.history;
    if (msgs.length <= MAX_HISTORY_MESSAGES) return msgs;
    const keep = msgs.slice(-MAX_HISTORY_MESSAGES);
    this.history = keep;
    return keep;
  }
}
