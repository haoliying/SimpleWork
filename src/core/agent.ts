import type { ConfigStore } from './config.js';
import { DEFAULT_CONTEXT_COMPRESSION } from './config.js';
import type { ContextCompressionConfig } from './config.js';
import { createProvider } from './llm/index.js';
import type { ChatMessage, LLMProvider, ToolSchema } from './llm/types.js';
import { builtinTools } from './tools/builtin.js';
import type { Tool, ToolContext, ToolResult } from './tools/types.js';
import type { McpManager } from './mcp/manager.js';
import type { SkillRegistry } from './skills/loader.js';
import { buildSystemPrompt } from './prompt.js';
import { sanitizeHistory } from './history.js';
import {
  buildSummaryMessages,
  clipSummary,
  estimateHistoryChars,
  serializeOldHistory,
  splitHistoryForCompression,
  trimHistorySafe,
} from './context.js';
import type { CompressionInfo } from './context.js';

export interface AgentEvents {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, ok: boolean, durationMs: number) => void;
  onTurn?: (turn: number) => void;
  onError?: (message: string) => void;
  /** 上下文自动压缩的开始/完成/失败通知 */
  onCompress?: (info: CompressionInfo) => void;
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
  /** 早期历史压缩后的摘要，注入系统提示；不占用界面消息 */
  summary = '';
  compressedCount = 0;
  compressedAt = 0;
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
    this.summary = '';
    this.compressedCount = 0;
    this.compressedAt = 0;
  }

  /** 打开历史会话时恢复压缩状态 */
  restoreContext(summary?: string, compressedCount?: number, compressedAt?: number): void {
    this.summary = summary ?? '';
    this.compressedCount = compressedCount ?? 0;
    this.compressedAt = compressedAt ?? 0;
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
      summary: this.summary,
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
    await this.maybeCompress(provider, model, events);
    const maxTurns = this.store.app.agent.maxTurns ?? 40;
    let finalText = '';

    for (let turn = 1; turn <= maxTurns; turn++) {
      events.onTurn?.(turn);
      // 工具循环里历史也可能变长（大量工具结果），每轮都检查一次
      await this.maybeCompress(provider, model, events);
      const messages: ChatMessage[] = [
        { role: 'system', content: this.systemPrompt() },
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

  private compressionConfig(): ContextCompressionConfig {
    return {
      ...DEFAULT_CONTEXT_COMPRESSION,
      ...(this.store.app.agent?.contextCompression ?? {}),
    };
  }

  /** 达到阈值时自动压缩早期历史；失败不阻断正常对话 */
  private async maybeCompress(
    provider: LLMProvider,
    model: string,
    events: AgentEvents,
  ): Promise<void> {
    const cfg = this.compressionConfig();
    if (!cfg.enabled) return;
    const chars = estimateHistoryChars(this.history);
    if (this.history.length < cfg.triggerMessages && chars < cfg.triggerChars) return;
    await this.compressOnce(provider, model, cfg, events, false);
  }

  /** 手动压缩（界面按钮 / API）：忽略触发阈值，但保留最小历史保护 */
  async compressNow(
    events: AgentEvents = {},
  ): Promise<{ ok: boolean; info?: CompressionInfo; error?: string }> {
    const { provider, model } = createProvider(this.store, this.providerId, this.modelId);
    let captured: CompressionInfo | undefined;
    const ok = await this.compressOnce(provider, model, this.compressionConfig(), {
      ...events,
      onCompress: (info) => {
        captured = info;
        events.onCompress?.(info);
      },
    }, true);
    const info: CompressionInfo = captured ?? {
      status: 'skipped',
      before: this.history.length,
      after: this.history.length,
      removed: 0,
      summaryChars: this.summary.length,
    };
    return ok ? { ok: true, info } : { ok: false, info, error: info.reason ?? '没有可压缩的历史' };
  }

  private async compressOnce(
    provider: LLMProvider,
    model: string,
    cfg: ContextCompressionConfig,
    events: AgentEvents,
    force: boolean,
  ): Promise<boolean> {
    const before = this.history.length;
    const charsBefore = estimateHistoryChars(this.history);
    const plan = splitHistoryForCompression(this.history, cfg.keepRecentMessages);
    if (!plan.old.length || plan.old.length < cfg.minOldMessages) {
      if (force) {
        events.onCompress?.({
          status: 'skipped',
          before,
          after: before,
          removed: 0,
          summaryChars: this.summary.length,
          charsBefore,
          reason: `早期消息只有 ${plan.old.length} 条，少于最小压缩数量 ${cfg.minOldMessages}`,
        });
      }
      return false;
    }

    events.onCompress?.({
      status: 'start',
      before,
      after: before,
      removed: plan.old.length,
      summaryChars: this.summary.length,
      charsBefore,
    });

    try {
      const messages = buildSummaryMessages(
        this.summary,
        serializeOldHistory(plan.old),
        cfg.summaryMaxChars,
      );
      const out = await provider.chat(
        {
          model,
          messages,
          temperature: 0,
          maxTokens: Math.min(4096, Math.max(512, Math.ceil(cfg.summaryMaxChars / 1.5))),
        },
        { signal: events.signal },
      );
      if (events.signal?.aborted) return false;
      const summary = clipSummary(out.message.content ?? '', cfg.summaryMaxChars);
      if (!summary) throw new Error('模型没有返回摘要内容');

      this.summary = summary;
      this.history = plan.keep;
      this.compressedCount++;
      this.compressedAt = Date.now();
      events.onCompress?.({
        status: 'done',
        before,
        after: this.history.length,
        removed: plan.old.length,
        summaryChars: summary.length,
        charsBefore,
      });
      return true;
    } catch (e) {
      if (events.signal?.aborted) return false;
      const reason = (e as Error).message ?? String(e);
      events.onCompress?.({
        status: 'error',
        before,
        after: before,
        removed: 0,
        summaryChars: this.summary.length,
        charsBefore,
        reason,
      });
      // 摘要失败也不能让请求无限膨胀：按安全边界兜底裁剪
      if (this.history.length > MAX_HISTORY_MESSAGES) {
        this.history = trimHistorySafe(this.history, MAX_HISTORY_MESSAGES);
      }
      return false;
    }
  }

  /** 超长时的兜底裁剪（按工具调用组边界，不拆配对） */
  private trimHistory(): ChatMessage[] {
    const keep = trimHistorySafe(this.history, MAX_HISTORY_MESSAGES);
    if (keep.length !== this.history.length) this.history = keep;
    return keep;
  }
}
