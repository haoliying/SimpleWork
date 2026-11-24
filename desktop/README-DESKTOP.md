# SimpleWork Desktop 使用说明

SimpleWork 桌面版 = 本地 Agent 工作台 + 原生窗口。引擎、配置、界面与 CLI 版完全同源，
所有数据都保存在你自己的电脑上，不依赖任何 SimpleWork 自有服务器。

## 获取 exe

| 方式 | 说明 |
| --- | --- |
| 直接用现成的 | 仓库里已打好包：`release8/SimpleWork-0.1.0-win-x64.exe`（约 100 MB，portable 单文件） |
| 自己重新打 | `npm --prefix desktop run dist` → 产出在 `release/` |

portable 版 = 免安装：双击即运行，可放 U 盘或任意目录。首次运行会把自己解压到
`%TEMP%\SimpleWork\`（这是 portable 机制的正常行为，退出后可清理）——注意配置**不会**写进这个
临时目录，而是写在你放 exe 的那个目录里。

## 快速开始

1. 双击 `SimpleWork-0.1.0-win-x64.exe`（portable 版，无需安装，可放任意目录）。
2. 首次启动会在**exe 同级目录**生成配置与默认工作区：

   ```
   config.json / models.json / mcp.json / skills.json / .env
   skills/  conversations/  workspace/
   desktop.json（状态）  desktop.log（日志）
   ```

   若以前用过 CLI/旧版，会把 `~/.simplework` 里的配置**复制**过来（原目录保留不动）。
3. 点左侧 **设置** 标签 → 在任意一家模型厂商下粘贴 API Key → 保存。
   推荐先配 DeepSeek / 智谱 / 通义（国内直连），Key 只写入本机 `.env`。
4. 回到对话，顶部选择厂商和模型，直接提问。

### 便携迁移

配置、历史对话、已装 Skill、工作区文件都在 exe 同级目录，**复制整个文件夹**到 U 盘或另一台
电脑，双击 exe 就能原样继续，不用重新配 Key。

需要放到别处（比如 exe 在只读目录）：设环境变量 `SIMPLEWORK_PORTABLE_DIR=<目录>` 指定配置位置。

## 概念速览

| 概念 | 说明 |
| --- | --- |
| 工作区 | Agent 读写文件、执行命令的默认目录（菜单：工具 → 切换工作区） |
| 模型 | 出厂预置 14 家厂商，填 Key 即用；Claude 走原生协议，其余 OpenAI 兼容 |
| MCP | 预置 15 个公开 MCP 服务器（文件系统、抓取、git、高德地图等），左侧开关即用 |
| Skill | 出厂自带 3 个中文 Skill，可在线搜索安装 30+ 免费 Skill（来源 GitHub 公开仓库） |
| 上下文压缩 | 长对话自动把早期历史总结成摘要；完整消息仍可搜索/复制/引用，摘要随会话保存 |

## 菜单

- **文件**：新建会话（Ctrl+N）、打开工作区/配置目录/Key 文件
- **工具**：切换工作区（重启生效）、重新加载配置、查看运行日志
- **帮助**：关于、使用说明

## 数据都在哪

假设 exe 放在 `D:\SimpleWork\`（下表路径中的 `<exe目录>` 就是它）：

| 内容 | 位置 |
| --- | --- |
| 密钥 | `<exe目录>\.env` |
| 配置覆盖 | `<exe目录>\{config,models,mcp,skills}.json` |
| 已安装 Skill | `<exe目录>\skills\` |
| 历史对话与上下文 | `<exe目录>\conversations\` |
| 工作区文件 | `<exe目录>\workspace\`（可在工具菜单更换） |
| 运行日志 | `<exe目录>\desktop.log` |

（开发模式 `npm --prefix desktop run start` 不启用便携目录，仍用 `~/.simplework`。）

## 已知限制

- **首次启动较慢**：内嵌引擎（Node + 依赖）启动约需 30–60 秒，界面会先显示「正在启动…」的
  占位页，属正常；Windows Defender 首次扫描新 exe 会更慢一些。
- **MCP 的 stdio 服务器**（filesystem 等）通过 `npx` 启动，需要本机装有 Node.js ≥ 18。
  没装也不影响：内置工具（文件读写、命令执行、网页抓取）与模型对话照常可用。
- 打包时已关闭 **asar 完整性校验**（`build.electronFuses.enableEmbeddedAsarIntegrityValidation = false`）：
  该 fuse 与 Electron 44 组合会导致 exe 静默退出。若升级 Electron 后可正常启动，可再打开它。
- 卸载 = 删除 exe 所在文件夹（配置、对话、Skill 都在里面），不会在系统里留其他东西。

## 从源码构建

```bash
# 在仓库根目录
npm install
npm run desktop:build        # 编译 + 同步载荷
npm --prefix desktop run dist  # 产出 release/SimpleWork-<版本>-win-x64.exe
```

打包要点（都在 `desktop/package.json` 的 `build` 字段）：

- `electronDist` 指向已下载好的 `desktop/node_modules/electron/dist`，避免联网重下 Electron
- `win.target = portable`，产物是单文件 exe；改成 `nsis` 可出安装向导版
- 国内网络可设镜像加速：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
