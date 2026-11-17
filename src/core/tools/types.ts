import type { ConfigStore } from '../config.js';
import type { JsonSchema } from '../llm/types.js';
import type { SkillRegistry } from '../skills/loader.js';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** 给 UI 的附加信息（如写入的文件路径） */
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  store: ConfigStore;
  skills: SkillRegistry;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 是否只读（只读工具默认免确认） */
  readOnly?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolInvocationEvent {
  type: 'start' | 'end' | 'error';
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  durationMs?: number;
}
