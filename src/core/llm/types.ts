export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage?: ChatUsage;
  /** 部分推理模型会把思维链放在这里 */
  reasoning?: string;
}

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (tc: ToolCall) => void;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  readonly protocol: string;
  chat(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ChatResult>;
  stream(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>;
  listModels(): Promise<string[]>;
}
