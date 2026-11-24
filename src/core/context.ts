import type { ChatMessage } from './llm/types.js';

/**
 * 上下文压缩：把较早的历史交给当前模型总结成一段摘要，注入系统提示；
 * 界面展示用的 ConvMessage 完全不动，所以「完整对话」永远可回看/搜索/引用。
 */

/** 单次送给模型做摘要的历史文本上限（字符数），超长时保留头尾 */
const MAX_SUMMARY_INPUT_CHARS = 16000;

export interface CompressionInfo {
  status: 'start' | 'done' | 'error' | 'skipped';
  /** 压缩前历史消息数 */
  before: number;
  /** 压缩后历史消息数 */
  after: number;
  /** 实际被摘要掉的消息数 */
  removed: number;
  /** 当前摘要字符数 */
  summaryChars: number;
  /** 压缩前估算字符数 */
  charsBefore?: number;
  reason?: string;
}

/** 粗略估算历史体积：正文 + 工具参数 + 工具结果 */
export function estimateHistoryChars(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) {
    n += (m.content ?? '').length;
    if (m.tool_call_id) n += m.tool_call_id.length;
    for (const tc of m.tool_calls ?? []) {
      n += (tc.function?.name ?? '').length + (tc.function?.arguments ?? '').length;
    }
  }
  return n;
}

interface MessageBlock {
  messages: ChatMessage[];
}

/**
 * 按安全边界分块：一条普通消息一块；助手的 tool_calls 连同后续所有 tool 回复算一块。
 * 这样裁剪/压缩都不会把 tool_call 和它的结果拆开。
 */
function groupBlocks(history: ChatMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === 'tool') {
      // 孤立的工具结果（理论上 sanitizeHistory 已清掉），并到上一块，避免它单独被留下
      if (blocks.length) blocks[blocks.length - 1].messages.push(m);
      else blocks.push({ messages: [m] });
      i++;
      continue;
    }
    const block: MessageBlock = { messages: [m] };
    i++;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      while (i < history.length && history[i].role === 'tool') {
        block.messages.push(history[i]);
        i++;
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/** 从尾部保留至少 keepRecentMessages 条消息，且只落在安全边界上 */
export function splitHistoryForCompression(
  history: ChatMessage[],
  keepRecentMessages: number,
): { old: ChatMessage[]; keep: ChatMessage[] } {
  const blocks = groupBlocks(history);
  if (blocks.length <= 1) return { old: [], keep: history.slice() };

  const want = Math.max(1, Math.floor(keepRecentMessages) || 1);
  let count = 0;
  let keepFrom = blocks.length - 1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    count += blocks[i].messages.length;
    keepFrom = i;
    if (count >= want) break;
  }
  const cut = history.length - count;
  return { old: history.slice(0, cut), keep: history.slice(cut) };
}

/** 压缩失败时的兜底裁剪，同样不拆工具调用组 */
export function trimHistorySafe(history: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (history.length <= maxMessages) return history.slice();
  const { keep } = splitHistoryForCompression(history, Math.max(1, maxMessages));
  return keep;
}

function clip(text: string, limit: number): string {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 把待压缩历史序列化成适合摘要的文本 */
export function serializeOldHistory(old: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of old) {
    if (m.role === 'user') {
      lines.push(`[用户] ${m.content ?? ''}`);
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map(
        (tc) => `  ↳ 调用工具 ${tc.function?.name ?? '?'}(${clip(tc.function?.arguments ?? '', 400)})`,
      );
      lines.push(`[助手] ${m.content ?? '（无正文）'}${calls.length ? `\n${calls.join('\n')}` : ''}`);
    } else if (m.role === 'tool') {
      lines.push(`[工具结果] ${clip(m.content ?? '', 3000)}`);
    } else {
      lines.push(`[${m.role}] ${m.content ?? ''}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > MAX_SUMMARY_INPUT_CHARS) {
    const head = text.slice(0, Math.floor(MAX_SUMMARY_INPUT_CHARS * 0.4));
    const tail = text.slice(-Math.floor(MAX_SUMMARY_INPUT_CHARS * 0.6));
    text = `${head}\n…[中间约 ${text.length - MAX_SUMMARY_INPUT_CHARS} 字为控制长度已省略]…\n${tail}`;
  }
  return text;
}

/** 构造摘要请求（不带工具，避免模型在压缩阶段又发起 tool_call） */
export function buildSummaryMessages(
  existingSummary: string | undefined,
  historyText: string,
  maxChars: number,
): ChatMessage[] {
  const system = [
    '你是 SimpleWork 的对话上下文压缩器。',
    '你的任务是把较早的对话历史压缩成一段高信息密度的中文摘要，供后续对话继续参考。',
    '必须保留：已确认的事实与结论、用户偏好与约束、文件路径/命令/配置项名称、关键数值、工具调用的重要结果、尚未完成的任务。',
    '可以丢弃：寒暄、重复表述、无结论的试错过程、大段原始日志。',
    '只输出摘要正文，不要写「以下是摘要」之类的开场白，不要解释你在做什么。',
  ].join('\n');

  const user = [
    existingSummary?.trim() ? `【已有摘要（请与新历史合并，不要丢失仍有效的信息）】\n${existingSummary.trim()}\n` : '',
    `【本轮待压缩的历史】\n${historyText}\n`,
    [
      '【输出要求】',
      '- 用简体中文，按主题分点，条理清晰。',
      `- 总长度不超过 ${Math.max(200, maxChars)} 个字符。`,
      '- 不要虚构历史里没有的信息；不确定的内容标注「待确认」。',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 限制摘要长度（按字符，中文场景下比 token 估算更直观） */
export function clipSummary(text: string, maxChars: number): string {
  const s = String(text ?? '').trim();
  const limit = Math.max(200, maxChars);
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** 注入系统提示的摘要段落 */
export function formatSummarySection(summary: string): string {
  return [
    '## 已压缩的早期对话摘要',
    '以下是本对话早期历史压缩后的摘要，请作为背景事实使用。界面中的完整消息仍保留，可搜索和引用；若摘要与用户当前明确要求冲突，以当前要求为准。',
    '',
    summary.trim(),
    '',
  ].join('\n');
}
