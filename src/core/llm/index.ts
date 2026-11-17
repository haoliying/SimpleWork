import { resolveApiKeyOf } from '../config.js';
import type { ConfigStore, ProviderDef } from '../config.js';
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import type { LLMProvider } from './types.js';

export interface ResolvedLLM {
  provider: LLMProvider;
  def: ProviderDef;
  model: string;
  /** 缺失的密钥变量名（用于友好报错） */
  missingKeyEnv?: string;
}

/** 直接用一个供应商定义构造 LLM（用于「测试连接」这种还没落盘的场景） */
export function createProviderFromDef(def: ProviderDef, modelId?: string): ResolvedLLM {
  const apiKey = resolveApiKeyOf(def);
  const model =
    modelId || def.defaultModel || def.models[0]?.id;
  if (!model) throw new Error(`供应商 ${def.id} 没有可用模型`);

  let provider: LLMProvider;
  if (def.protocol === 'anthropic') {
    provider = new AnthropicProvider({ id: def.id, baseURL: def.baseURL, apiKey });
  } else if (def.protocol === 'ollama') {
    provider = new OllamaProvider({ id: def.id, baseURL: def.baseURL });
  } else {
    provider = new OpenAICompatibleProvider({ id: def.id, baseURL: def.baseURL, apiKey });
  }
  return { provider, def, model, missingKeyEnv: !apiKey ? def.apiKeyEnv : undefined };
}

export function createProvider(store: ConfigStore, providerId?: string, modelId?: string): ResolvedLLM {
  const def = providerId ? store.provider(providerId) : store.provider();
  return createProviderFromDef(
    def,
    modelId || (providerId === undefined ? store.models.active.model : undefined),
  );
}
