# SimpleWork

本地优先的轻量 Agent 工作台。参照 WorkBuddy 的模式（Agent 循环 + 内置工具 + MCP + Skill），但**所有远程能力都由本地配置文件驱动**：端点、MCP 服务器、Skill 来源都由你控制，不使用模拟数据。

- 预置 **15 家大模型厂商的真实连接端点**（国产 + 国际 + 本地），**不内置任何假模型 ID**：填 Key 后从服务端 `/v1/models` 拉取真实模型，或手工添加（见 §3）
- 预置 **15 个公开 MCP 服务器**（官方实现 + 社区常用），`sw mcp enable <id>` 即用
- 预置 **3 个真实公开 Skill 仓库源**，在线检索后从仓库安装；不内置演示 Skill，也没有离线精选别名
- 一个 `sw` 命令行 + 一个本地 Web 界面（`http://127.0.0.1:8787`），不依赖任何云端服务
- **桌面版**：Electron 原生窗口（`sw` 同款引擎），可打包成单个免安装 exe（见下文 §11）

---

## 1. 快速开始

```bash
cd SimpleWork
npm install            # 安装依赖（MCP SDK / undici / tsx）
npm run build          # 编译到 dist/
npm link               # 注册 sw / simplework 命令（可选）
```

不想 link 也可以直接跑：

```bash
npx tsx src/index.ts ...      # 开发模式
node dist/index.js ...        # 编译后
```

**三步跑起来：**

```bash
# 1) 生成你的本地配置目录 ~/.simplework 并复制 .env
sw init

# 2) 填 Key（任选一家即可）
notepad ~/.simplework/.env        # 例如 DEEPSEEK_API_KEY=sk-xxxx

# 3) 体检 + 开聊
sw doctor
sw
```

只想离线用？把模型切到本地 Ollama：

```bash
ollama serve &
sw models fetch ollama      # 拉取本机已下载的模型列表
sw models use ollama
```

Ollama 在**另一台机器**（局域网）上时，把 `~/.simplework/models.json` 里的 `baseURL` 换成它的地址：

```json
{
  "active": { "provider": "ollama", "model": "qwen2.5:14b" },
  "providers": [
    {
      "id": "ollama",
      "baseURL": "http://172.16.9.107:11434",
      "defaultModel": "qwen2.5:14b",
      "models": [{ "id": "qwen2.5:14b", "label": "Qwen2.5 14B（局域网）", "context": 32768, "tools": true }]
    }
  ]
}
```

> Ollama 走的是**原生 `/api/chat`**，不是 OpenAI 兼容层 `/v1`。  
> 原因是 `/v1` 对 Qwen 系列的工具调用支持不可靠（会把 tool_calls 以乱码混进正文），  
> 而原生端点返回标准 `tool_calls`，Agent 的工具循环才能正常跑。

局域网/内网地址（`10.x`、`172.16–31.x`、`192.168.x`、`.local`）**自动不走代理直连**，  
所以公司电脑开着 `HTTP_PROXY` 也能访问内网的 Ollama，不需要额外配 `NO_PROXY`。

---

## 2. 配置体系：一切都在本地文件里

配置分三层，**后者覆盖前者**，改完立即生效：

| 层级   | 位置                          | 用途                        |
| ---- | --------------------------- | ------------------------- |
| 出厂预置 | `SimpleWork/config/*.json`  | 随项目分发，别直接改（升级会被覆盖）        |
| 用户级  | `~/.simplework/*.json`      | 你的个人配置（`sw init` 生成）      |
| 项目级  | `<你的项目>/.simplework/*.json` | 项目专属（`sw init --here` 生成） |

```
~/.simplework/
├── config.json     主配置：Agent 参数、工具开关、Web 端口、搜索后端
├── models.json     厂商端点清单 + 你拉取/添加的真实模型（出厂不含模型 ID）
├── mcp.json        MCP 服务器清单（stdio / http，启用开关）
├── skills.json     真实 Skill 仓库源 + 用户自定义别名（出厂精选为空）
├── .env            你的密钥（不会被提交）
└── skills/         已安装的 Skill
```

`.env` 读取顺序：`./.simplework/.env` → `./.env` → `~/.simplework/.env`。  
配置里到处可以写 `${ENV_VAR}` 占位符，运行时自动展开（例如 MCP 的 `"BRAVE_API_KEY": "${BRAVE_API_KEY}"`）。

常用命令：

```bash
sw config path                      # 看当前生效的是哪些文件
sw config get agent.maxTurns
sw config set agent.temperature 0.5
sw config set web.port 9000
```

---

## 3. 大模型端点（填 Key → 拉取真实模型）

| id             | 厂商                            | 协议                         | 环境变量                  |
| -------------- | ----------------------------- | -------------------------- | --------------------- |
| `deepseek`     | DeepSeek 深度求索                 | OpenAI 兼容                  | `DEEPSEEK_API_KEY`    |
| `zhipu`        | 智谱 GLM                        | OpenAI 兼容                  | `ZHIPU_API_KEY`       |
| `qwen`         | 通义千问 DashScope                | OpenAI 兼容                  | `DASHSCOPE_API_KEY`   |
| `hunyuan`      | 腾讯混元 Hunyuan                  | OpenAI 兼容                  | `HUNYUAN_API_KEY`     |
| `moonshot`     | 月之暗面 Kimi                     | OpenAI 兼容                  | `MOONSHOT_API_KEY`    |
| `doubao`       | 火山方舟 豆包                       | OpenAI 兼容                  | `ARK_API_KEY`         |
| `siliconflow`  | 硅基流动                          | OpenAI 兼容                  | `SILICONFLOW_API_KEY` |
| `minimax`      | MiniMax 海螺                    | OpenAI 兼容                  | `MINIMAX_API_KEY`     |
| `openai`       | OpenAI                        | OpenAI                     | `OPENAI_API_KEY`      |
| `anthropic`    | Anthropic Claude              | **原生 Messages API**        | `ANTHROPIC_API_KEY`   |
| `gemini`       | Google Gemini                 | OpenAI 兼容端点                | `GEMINI_API_KEY`      |
| `openrouter`   | OpenRouter 聚合                 | OpenAI 兼容                  | `OPENROUTER_API_KEY`  |
| `groq`         | Groq                          | OpenAI 兼容                  | `GROQ_API_KEY`        |
| `ollama`       | Ollama 本地/局域网                 | **原生 `/api/chat`**（工具调用可靠） | 无需                    |
| `local-openai` | vLLM / LM Studio / Xinference | OpenAI 兼容                  | 无需                    |

```bash
sw models list                 # 看哪些已配 Key、当前用的是哪个
sw models fetch zhipu          # 从服务端拉取该厂商真实模型列表，回写本地配置
sw models use zhipu            # 切换厂商（须先拉取或添加模型）
sw models use openai:gpt-4o    # 厂商:模型 一起指定
sw models test zhipu           # 发一条最小请求验证连通性
```

**程序里不预置任何假模型 ID。** 顶栏下拉里出现的每一个模型，都来自你实际账号的接口返回，或你自己录入的真实 ID。首次运行时下拉会显示「暂无模型，请先在 ◈ 模型 里拉取」。

- 命令行：`sw models fetch <provider>` 拉全量列表并写回配置。
- 界面：左侧「◈ 模型」→ 对应厂商卡片 → **「拉取模型」**，请求 `/v1/models`，自动过滤 embedding / 语音 / 绘图等非聊天模型。
- Key 保存在 `<配置目录>/.env`（便携版为 exe 同级 `.env`）；便携版不会读 `~/.simplework/.env`。

### 3.1 自定义模型（任意 OpenAI 兼容 / Anthropic / Ollama 服务）

除了预置厂商，你可以添加**任意**模型服务：公司内网网关、OpenAI 兼容中转站、OneAPI / NewAPI、  
vLLM、LM Studio、云厂商私有部署等。

**界面方式**：左侧「◈ 模型」面板 →「＋ 添加自定义模型」，填写：

- 显示名称 + 唯一标识（英文小写，如 `corp-llm`）
- 协议：OpenAI 兼容（绝大多数）/ Anthropic 原生 / Ollama
- 接口地址 baseURL（OpenAI 兼容填到 `/v1` 为止；Ollama 填 `http://IP:11434`，不要带 `/api`）
- API Key（直接粘贴，会自动写入本机 `.env`，不落 models.json）
- 模型列表：每行 `模型ID` 或 `模型ID | 显示名 | 上下文长度`；点「拉取模型列表」可自动从服务拉取

表单里的「测试连接」「拉取模型列表」会直接对你的服务发真实请求，保存前就能验证。

**命令行方式**：

```bash
sw models add                     # 交互式问答
sw models add --name "公司内部模型" --base-url https://llm.corp.com/v1 \
              --key-env CORP_KEY --model gpt-4o --model claude-3
sw models remove corp-llm         # 删除（出厂厂商会被隐藏而不是真删）
```

自定义模型与预置厂商完全同权：可切换、可设为默认、界面编辑/删除（面板里有「编辑」「删除」按钮）。

---

## 4. 预置 MCP（公开、可直装）

| id               | 说明                 | 默认   | 需要                     |
| ---------------- | ------------------ | ---- | ---------------------- |
| `filesystem`     | 官方文件系统（限定目录读写）     | ✅ 启用 | Node                   |
| `memory`         | 官方知识图谱记忆           | ✅ 启用 | Node                   |
| `everything`     | 官方自检服务器（验证链路用）     | 停用   | Node                   |
| `context7`       | 最新开发文档检索           | 停用   | Node（免 Key）            |
| `brave-search`   | Brave 联网搜索         | 停用   | `BRAVE_API_KEY`        |
| `github`         | GitHub 仓库/Issue/PR | 停用   | `GITHUB_TOKEN`         |
| `postgres`       | PostgreSQL 只读查询    | 停用   | `DATABASE_URL`         |
| `puppeteer`      | 浏览器截图/点击           | 停用   | Node                   |
| `playwright`     | 微软 Playwright MCP  | 停用   | Node                   |
| `amap`           | 高德地图（地理编码/路径规划）    | 停用   | `AMAP_MAPS_API_KEY`    |
| `git`            | 官方 Git 服务器         | 停用   | `uv`（`pip install uv`） |
| `fetch`          | 官方网页转 Markdown     | 停用   | `uv`                   |
| `time`           | 官方时间与时区            | 停用   | `uv`                   |
| `sqlite`         | 官方 SQLite 读写       | 停用   | `uv`                   |
| `my-http-server` | HTTP 类型 MCP 配置模板   | 停用   | —                      |

```bash
sw mcp list                # 列出全部 + 实际连接结果 + 各服务器提供的工具
sw mcp enable github       # 启用（写入本地 mcp.json）
sw mcp test filesystem     # 单独连一次看看
sw mcp add my-tool npx -y some-mcp-package     # 手动加一个自己的
```

> Windows 上 `npx` / `uvx` 是 `.cmd`，无法直接 spawn。SimpleWork 会自动把它们包装成 `cmd.exe /c`，所以开箱即用。

---

## 5. Skills（下载网上的免费 Skill）

**三个公开源**（都在 `config/skills.json` 里，可自行增删）：

| 源                | 仓库                                                                              | 许可                                                       |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `anthropic`      | [anthropics/skills](https://github.com/anthropics/skills)                       | Apache-2.0（docx/pdf/pptx/xlsx 为 source-available，仅供个人参考） |
| `superpowers`    | [obra/superpowers](https://github.com/obra/superpowers)                         | MIT                                                      |
| `alirezarezvani` | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | 见仓库 LICENSE                                              |

```bash
sw skills search pdf         # 在线检索公开仓库，列出真实路径
sw skills install anthropics/skills/skills/pdf                      # 按真实路径安装
sw skills install obra/superpowers/skills/test-driven-development   # 装任意仓库子目录
sw skills list               # 已安装
sw skills remove pdf
sw skills create my-skill    # 生成一个 SKILL.md 模板自己写
```

**不预置任何演示 Skill，也没有离线精选别名**：检索结果和安装路径都指向真实仓库目录；界面「安装」按钮用的也是同一个真实路径。

**Skill 是渐进加载的**：系统提示里只放 `名称 + 一句话描述`（成本极低），模型判断相关时才用 `use_skill` 工具把完整 SKILL.md 拉进上下文——和 WorkBuddy 的机制一致。

> 检索遇到 `GitHub API 限流`？在线通道是锦上添花，**安装不依赖 API**（走 `git sparse-checkout`，只拉目标子目录）。想让在线检索也稳定，在 `.env` 里配 `GITHUB_TOKEN`。

---

## 6. 命令行

```bash
sw                         交互式对话（/help 看内联命令，/exit 退出）
sw ask "读一下这个项目的结构"      单轮问答，输出直接打到终端
sw serve --port 8787       启动本地 Web 界面
sw doctor                  体检：模型 Key / MCP 连通性 / Skill / 运行时
sw init [--here]           初始化配置目录
sw config | models | mcp | skills  见上文各节
```

内联命令：`/help` `/clear` `/model` `/models <id>` `/skills` `/mcp` `/exit`

---

## 7. Web 界面

```bash
sw serve                    # 默认 http://127.0.0.1:8787
```

- **多会话**：所有对话自动保存到 `<配置目录>/conversations/<id>.json`（CLI 为 `~/.simplework/conversations/`，桌面便携版为 exe 同级 `conversations/`），包含「展示消息」和「模型上下文」两份数据；关掉界面/重启进程后点「💬 历史对话」继续上次的上下文，切换会话时自动恢复
- **最左侧图标栏**：`💬 对话`、`◈ 模型`、`⑃ MCP`、`❖ Skills`、`⚙ 设置`；再点一次当前图标（或点 `⇤`）即把功能面板收进最左边，只留 52px 图标条
- **主区**：你的消息靠右（蓝色气泡），回复靠左；流式输出
- **执行过程默认收起**：工具调用不再铺开占用版面，只在回复下方留一行「⚙ 执行过程 · N 步 · 1.4s」，点开才看每个工具的入参与返回
- **上下文自动压缩**（见 §7.4）：长对话达到阈值时自动把早期历史总结成摘要，界面完整消息不丢
- **跨对话引用**：在输入框左侧点 `🔗 引用`（见 §7.3），可把别的对话里的内容/成果带进当前提问
- 会话可以新建、重命名（默认取首条消息）、删除、清空上下文（保留会话条目）
- 只监听 `127.0.0.1`，不对外暴露；所有数据都在本机

### 7.1 两种搜索

| 入口 | 范围 | 用法 |
| --- | --- | --- |
| 顶栏 `🔍`（或 `Ctrl/Cmd + F`） | **当前对话内** | 输入即高亮全部命中，黄色为命中、深黄为当前项；`Enter` 下一个、`Shift+Enter` 上一个、右上角 `n / N` 显示序号、`Esc`/`✕` 关闭并清除高亮 |
| 左侧 `💬 对话` 面板顶部搜索框 | **全部对话（全局）** | 服务端遍历 `conversations/*.json`，返回命中的会话列表（标题 + 命中片段 + 命中次数，关键词高亮）；点结果直接打开该会话并自动定位第一个匹配 |

### 7.2 四种复制

鼠标移到消息上（右上角）即可看到复制按钮：

| 位置 | 按钮 | 复制内容 |
| --- | --- | --- |
| 会话列表项 `⧉` | 复制整场对话 | 该会话全部消息文本（含工具名与耗时） |
| AI 回复 | `复制本轮` | 【提问】+【回答】+【执行过程】，一整轮完整拷走 |
| AI 回复 | `复制回答` | 只拷回答正文 |
| 你的消息 | `复制` | 该条消息 |

**局部区域**也能单独复制：代码块右上角 `⧉`（只拷代码）、工具输出卡片右上角 `⧉`（只拷该工具的返回内容）。

### 7.3 跨对话引用（引用另一个对话的内容和成果）

在输入框左侧点 `🔗 引用`，从其他会话里挑选内容一起发给模型——适合「把上次调研的结论用到这次写作」「复用另一个对话里生成的方案/代码/工具成果」。

- **三种引用粒度**（可多选）：整场对话全部内容 / 单条消息（提问或回答）/ 某个工具调用的输入与返回结果
- 弹窗左侧选会话、右侧勾选内容；选中的引用以蓝色小标签显示在输入框上方，点标签可跳回来源、点 `×` 移除
- 发送后服务端**只按「会话 ID + 位置」从磁盘重新读取引用内容**（不信任界面传来的文本，防止伪造），格式化注入本次提问的上下文；消息气泡内显示引用卡片，点它可跳转到来源会话并高亮定位那条消息或工具
- 引用随会话一起保存（`messages[].refs`），重启后回看仍可追溯；「复制本轮/整场对话」会把引用内容一并复制
- 引用源被删除不影响已发送的引用（保存的是内容快照）

会话文件长这样：

```json
{
  "id": "mvg317fp-zogmhs",
  "title": "记住：我的代号是蓝鲸42",
  "createdAt": 1792464416485,
  "updatedAt": 1792464720734,
  "provider": "ollama",
  "model": "qwen2.5:14b",
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "summary": "早期历史压缩后的摘要（可选）",
  "compressedCount": 1,
  "messages": [{ "role": "user", "text": "…", "ts": 1792464416490 }]
}
```

`history` 是喂给模型的原始上下文（含 tool 消息），压缩后只保留最近一段；`summary` 是早期历史的摘要，注入系统提示；`messages` 是界面回看用的展示数据（含工具调用耗时/返回），**压缩不影响它**。中断/断线时会先存用户输入，再尽量保存已产出的内容。

### 7.4 上下文自动压缩

长对话里模型上下文会不断膨胀。SimpleWork 会在每轮请求前检查：消息数或估算字符数达到阈值时，让**当前模型**把较早的历史总结成中文摘要，并把这段摘要注入系统提示；最近消息原样保留，继续参与对话。

- **完整历史不丢**：只压缩 `history`，`messages` 里的完整问答、工具过程、搜索/复制/跨对话引用全部照常可用
- **工具调用不会拆坏**：按「助手 tool_calls + 后续 tool 结果」成组切分，摘要阶段不传工具，避免模型再次发起调用
- **可追溯、可迁移**：摘要、压缩次数、时间都写进会话 JSON，重启或复制配置目录后仍生效；会话列表会标 `🗜 已压缩`
- **可见**：触发时会显示「🗜 上下文已压缩：48 → 18 条 · 摘要 1.2k 字」；输入框下方常驻显示当前上下文状态
- **可控**：顶栏 `🗜 压缩上下文` 可手动压缩；`⚙ 设置 → 上下文自动压缩` 可改阈值或关闭自动压缩

配置项（`config/config.json`，也可在设置界面改）：

```json
"agent": {
  "contextCompression": {
    "enabled": true,
    "triggerMessages": 48,
    "triggerChars": 32000,
    "keepRecentMessages": 16,
    "summaryMaxChars": 3000,
    "minOldMessages": 6
  }
}
```

`triggerMessages` / `triggerChars` 任一达到即触发；`keepRecentMessages` 是至少保留的最近消息数；`minOldMessages` 防止历史过短时生成无意义摘要。若摘要请求失败，不会中断正常对话，只会按安全边界做兜底裁剪。

---

## 8. 内置工具

| 工具                                       | 说明                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `read_file` / `write_file` / `edit_file` | 带行号读取、写入、精确替换（要求原文唯一）                                               |
| `list_dir` / `glob` / `grep`             | 列目录、通配符查找、正则搜索（自动跳过 node_modules/.git）                              |
| `run_command`                            | 执行 shell（Windows 优先 Git Bash，退回 PowerShell），可配超时                    |
| `web_search`                             | 默认免 Key 的 DuckDuckGo；配了 `TAVILY_API_KEY`/`BRAVE_API_KEY` 自动改用官方 API |
| `web_fetch`                              | 抓网页转纯文本                                                             |
| `todo_write`                             | 多步骤任务时维护清单                                                          |
| `use_skill`                              | 加载 Skill 全文                                                         |

工具都可以在 `config.json` 的 `tools.builtin` 里逐项关掉，MCP 工具也可以整体关掉（`tools.mcpEnabled`）。

---

## 9. 源码结构

```
src/
├── core/
│   ├── paths.ts        三级目录解析（出厂/用户级/项目级）
│   ├── env.ts          .env 加载 + ${VAR} 展开
│   ├── config.ts       配置分层合并（按 id 合并 providers/servers/skills）
│   ├── http.ts         代理感知的 fetch + SSE / NDJSON 流解析
│   ├── llm/            OpenAI 兼容 / Anthropic 原生 / Ollama 原生 三套 Provider
│   ├── tools/          工具注册表 + 内置工具实现
│   ├── mcp/manager.ts  MCP 客户端（stdio / streamableHttp / sse）
│   ├── skills/         SKILL.md 加载器 + 下载器（git sparse / tarball 兜底）
│   ├── agent.ts        Agent 循环（流式 + 工具调用 + 自动压缩 + 安全裁剪）
│   ├── context.ts      上下文压缩（安全分块、摘要生成、系统提示注入）
│   ├── conversations.ts 会话仓库（历史对话 + 上下文 + 摘要持久化）
│   ├── history.ts      上下文修复（丢弃中断残留的不完整工具轮次）
│   ├── prompt.ts       系统提示组装
│   └── session.ts      组装上面所有东西成一个会话
├── cli/commands.ts     sw 命令实现
├── web/                node:http 服务 + 单文件前端
└── index.ts            CLI 入口
```

---

## 10. 常见问题

**代理环境连不上模型？**  
Node 内置 fetch 不读 `HTTP_PROXY`。SimpleWork 自己实现了代理感知的请求层，会自动用 `HTTPS_PROXY`/`HTTP_PROXY`（并遵守 `NO_PROXY`，本地地址直连）。

**`sw mcp list` 里 git/fetch/time/sqlite 连不上？**  
它们走 Python 的 `uvx`，先 `pip install uv`（或 `irm https://astral.sh/uv/install.ps1 | iex`）。不需要就保持停用。

**想加自己的模型厂商？**  
编辑 `~/.simplework/models.json`，照抄一条改 `id / baseURL / apiKeyEnv / models` 即可，协议填 `openai`（绝大多数）或 `anthropic`。

**Skill 装到哪了？**  
优先项目级 `<cwd>/.simplework/skills`，没有项目配置时装到 `~/.simplework/skills`。加 `--user` / `--project` 可强制指定。

---

## License

MIT。第三方 Skill / MCP 的许可见各自仓库。

---

## 11. 桌面版（Electron）

CLI 与 Web 之外，SimpleWork 还有一个 Electron 桌面版：同款 Agent 引擎，原生窗口，  
应用内可直接填写 API Key、开关 MCP、安装 Skill，支持菜单栏打开配置目录 / 切换工作区。

```bash
npm install                        # 根目录依赖
npm run desktop:build              # 编译引擎 + 同步桌面载荷
npm --prefix desktop run start     # 开发模式启动窗口
npm --prefix desktop run dist      # 打包：release/SimpleWork-<版本>-win-x64.exe
```


```

- 产物为 **portable 单文件 exe**：双击即用，无需安装
- 仓库里已有一份现成产物：`release8/SimpleWork-0.1.0-win-x64.exe`（约 100 MB），不想打包可直接用

### 11.1 便携模式：配置跟 exe 走

打包后的桌面版是**便携模式**——配置目录就是 **exe 所在目录**，不再写 `~/.simplework`：

```

SimpleWork-0.1.0-win-x64.exe     ← 程序  
config.json                      ← 主配置（Agent 参数、工具开关）  
models.json                      ← 厂商端点 + 你拉取/添加的真实模型  
mcp.json                         ← MCP 服务器清单与开关  
skills.json                      ← Skill 真实仓库源（精选留给你自己登记）  
.env                             ← API Key（只在本机）  
skills/                          ← 下载的 Skill  
conversations/                   ← 历史对话与上下文  
workspace/                       ← 默认工作区（Agent 的 cwd）  
desktop.json / desktop.log       ← 桌面版状态与日志

```

- **首次启动**会自动生成这些文件：先把 `~/.simplework` 里的旧配置**复制**过来（原目录不动），
  缺的再用出厂预置补齐。复制规则是「目标已存在就不覆盖」，不会冲掉你改过的配置。
- **迁移**：把整个文件夹（exe + 这些文件）复制到 U 盘或另一台电脑，双击 exe 即可原样继续，
  包括历史对话、已装的 Skill 和已填的 Key。
- 不想用便携目录：`SIMPLEWORK_PORTABLE_DIR=<目录>` 可指定位置；CLI 侧用 `SIMPLEWORK_CONFIG_DIR=<目录>`
  （不设时 CLI 仍然用 `~/.simplework`）。
- 开发模式（`npm --prefix desktop run start`）不启用便携目录，仍用 `~/.simplework`，避免污染源码目录。

- 图标、菜单、窗口参数在 `desktop/main.cjs`；打包配置在 `desktop/package.json` 的 `build` 字段
- 已验证：exe 启动 → 内嵌服务随机端口 → `/api/state` 与界面均正常返回
- 桌面版详细说明见 `desktop/README-DESKTOP.md`
```
