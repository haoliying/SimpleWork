import type { ChatMessage } from './llm/types.js';

/**
 * 修复可能被中断的上下文：
 * - 丢弃没有配对 tool 回复的 assistant.tool_calls（否则下一轮请求会被厂商拒绝）
 * - 丢弃孤立的 tool 消息
 * 正常结束的对话经过这里不会有任何变化。
 */
export function sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const want = new Set(m.tool_calls.map((t) => t.id));
      const replies: ChatMessage[] = [];
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') {
        replies.push(history[j]);
        j++;
      }
      const got = new Set(replies.map((r) => r.tool_call_id));
      if ([...want].every((id) => got.has(id))) {
        out.push(m, ...replies);
        i = j - 1;
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }
    if (m.role === 'tool') continue;
    out.push(m);
  }
  return out;
}
