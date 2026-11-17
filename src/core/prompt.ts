import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ConfigStore } from './config.js';
import type { SkillRegistry } from './skills/loader.js';
import type { ToolSchema } from './llm/types.js';

export interface PromptContext {
  cwd: string;
  store: ConfigStore;
  skills: SkillRegistry;
  mcpTools: ToolSchema[];
  builtinToolNames: string[];
  model: string;
  providerName: string;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { store, skills, cwd } = ctx;
  const app = store.app;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const mcpLines = ctx.mcpTools.length
    ? ctx.mcpTools
        .map((t) => `- ${t.name}：${t.description.slice(0, 160)}`)
        .join('\n')
    : '（当前没有已连接的 MCP 工具。可执行 sw mcp enable <id> 开启）';

  const parts = [
    `你是 SimpleWork —— 一个本地优先的 AI 工作台助手。所有能力（大模型、MCP 工具、Skill）都由用户本机配置驱动。`,
    ``,
    `## 运行环境`,
    `- 操作系统：${os.platform()} ${os.release()}（${os.arch()}）`,
    `- 工作目录：${cwd}`,
    `- 当前时间：${stamp}`,
    `- 当前模型：${ctx.providerName} / ${ctx.model}`,
    ``,
    `## 工作原则`,
    `1. 先理解任务，再动手。能直接回答的就别绕弯子，需要操作文件的就用工具。`,
    `2. 优先使用工具获取真实信息，不要凭记忆编造文件内容、命令输出或网页内容。`,
    `3. 修改文件前先读取确认；编辑用 edit_file 精确替换，不要整篇重写。`,
    `4. 执行有副作用的命令（删除、提交、发布）前，先说明你要做什么。`,
    `5. 任务复杂时先用 todo_write 列出步骤，再逐步执行。`,
    `6. 全部完成后，用简短的中文总结你做了什么、产出了哪些文件。`,
    ``,
    `## 内置工具`,
    ctx.builtinToolNames.map((n) => `- ${n}`).join('\n'),
    ``,
    `## 已连接的 MCP 工具`,
    mcpLines,
    ``,
    `## 可用 Skill（渐进加载，需要时再用）`,
    `下面只是目录。当某个 Skill 的描述与当前任务匹配时，先用 use_skill 工具加载它的完整说明，再按说明执行：`,
    skills.catalog(),
    ``,
  ];

  // 项目记忆注入
  const memFile = path.join(cwd, app.memory.dir, app.memory.injectFile);
  if (app.memory.enabled && fs.existsSync(memFile)) {
    try {
      const mem = fs.readFileSync(memFile, 'utf8').trim();
      if (mem) parts.push(`## 项目记忆（${app.memory.dir}/${app.memory.injectFile}）`, mem, ``);
    } catch {
      /* ignore */
    }
  }

  if (app.agent.systemPromptAppend?.trim()) {
    parts.push(`## 用户自定义规则`, app.agent.systemPromptAppend.trim(), ``);
  }

  parts.push(
    `## 输出风格`,
    `- 用简体中文回复，代码/命令/路径保持原样。`,
    `- 简洁务实，不堆砌客套话，不复述显而易见的内容。`,
  );

  return parts.join('\n');
}
