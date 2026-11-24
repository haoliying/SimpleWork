import type { ConfigStore } from './config.js';
import { ConfigStore as Store } from './config.js';
import { SkillRegistry } from './skills/loader.js';
import { McpManager } from './mcp/manager.js';
import type { McpStatus } from './mcp/manager.js';
import { Agent } from './agent.js';

export interface SessionOptions {
  cwd?: string;
  /** 复用外部配置实例（Web 服务用它保证热加载对所有 Agent 生效） */
  store?: ConfigStore;
  providerId?: string;
  modelId?: string;
  connectMcp?: boolean;
  mcpTimeoutMs?: number;
  onMcpStatus?: (s: McpStatus) => void;
}

export class Session {
  readonly cwd: string;
  readonly store: ConfigStore;
  readonly skills: SkillRegistry;
  readonly mcp: McpManager;
  readonly agent: Agent;
  mcpStatus: McpStatus[] = [];

  constructor(opts: {
    cwd: string;
    store: ConfigStore;
    skills: SkillRegistry;
    mcp: McpManager;
    agent: Agent;
  }) {
    this.cwd = opts.cwd;
    this.store = opts.store;
    this.skills = opts.skills;
    this.mcp = opts.mcp;
    this.agent = opts.agent;
  }

  static async create(options: SessionOptions = {}): Promise<Session> {
    const cwd = options.cwd ?? process.cwd();
    const store = options.store ?? new Store(cwd);
    const skills = new SkillRegistry(cwd);
    const mcp = new McpManager(store.app.tools.mcpToolNamePrefix || 'mcp__');
    const agent = new Agent({
      cwd,
      store,
      skills,
      mcp,
      providerId: options.providerId,
      modelId: options.modelId,
    });
    const session = new Session({ cwd, store, skills, mcp, agent });

    if ((options.connectMcp ?? true) && store.app.tools.mcpEnabled) {
      const statuses = await mcp.connectAll(
        store.mcp.servers,
        cwd,
        options.mcpTimeoutMs ?? 30000,
      );
      session.mcpStatus = statuses;
      for (const s of statuses) options.onMcpStatus?.(s);
    }
    return session;
  }

  /** 派生一个新的 Agent（多会话场景：每个会话一个实例，共享 MCP / Skill / 配置） */
  spawnAgent(providerId?: string, modelId?: string): Agent {
    return new Agent({
      cwd: this.cwd,
      store: this.store,
      skills: this.skills,
      mcp: this.mcp,
      providerId: providerId ?? this.agent.currentModel().providerId,
      modelId: modelId ?? this.agent.currentModel().modelId,
    });
  }

  async dispose(): Promise<void> {
    await this.mcp.closeAll();
  }
}
