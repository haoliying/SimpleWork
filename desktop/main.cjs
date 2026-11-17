/**
 * SimpleWork Desktop - Electron 主进程
 *
 * 结构：主进程内起一个只监听 127.0.0.1 的本地服务（复用同一套 Agent 引擎），
 * 窗口只是一个浏览器容器。所有数据仍然保存在本机，不访问任何 SimpleWork 自有服务器。
 *
 * 便携模式：打包后配置目录 = exe 所在目录（config.json / models.json / mcp.json /
 * skills.json / .env / skills/ / conversations/ / workspace/），整个文件夹复制到
 * U 盘或另一台电脑即可完整迁移。开发模式（electron .）仍用 ~/.simplework。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const APP_DIR = __dirname;
const PAYLOAD_DIR = path.join(APP_DIR, 'payload');
const FACTORY_CONFIG_DIR = path.join(PAYLOAD_DIR, 'config');
const HOME_CONFIG_DIR = path.join(os.homedir(), '.simplework');

/* ------------------------------ 便携目录解析 ------------------------------ */

/** 判断是不是临时解压目录（portable exe 会把应用解到 %TEMP% 再运行） */
function looksLikeTempDir(p) {
  const l = String(p || '').toLowerCase().replace(/\//g, '\\');
  if (!l) return true;
  for (const t of [process.env.TEMP, process.env.TMP, '/tmp']) {
    const v = String(t || '').toLowerCase().replace(/\//g, '\\');
    if (v && l.startsWith(v)) return true;
  }
  return l.includes('\\appdata\\local\\temp\\') || l.includes('\\temp\\');
}

/**
 * 便携根目录 = exe 所在目录。
 * electron-builder 的 portable 启动器会把真实 exe 目录写进 PORTABLE_EXECUTABLE_DIR；
 * 目录版（--win --dir）没有该变量，直接用 exe 的目录。
 */
function detectPortableRoot() {
  let exeDir = null;
  try {
    exeDir = path.dirname(app.getPath('exe'));
  } catch {
    /* ignore */
  }
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.env.SIMPLEWORK_PORTABLE_DIR,
    exeDir,
  ].filter(Boolean);
  let fallback = null;
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      if (!looksLikeTempDir(c)) return c;
      fallback = fallback || c;
    } catch {
      /* ignore */
    }
  }
  // 只找到临时目录：宁可用它（否则每次启动都换地方），但留一条记录便于排查
  if (fallback) console.log(`[SimpleWork] 便携目录疑似临时目录 -> ${fallback}`);
  return fallback;
}

// 也可用 SIMPLEWORK_PORTABLE_DIR 手动指定（开发调试/强制便携目录）
const forcedPortable = (process.env.SIMPLEWORK_PORTABLE_DIR || '').trim();
const PORTABLE_ROOT = forcedPortable
  ? path.resolve(forcedPortable)
  : app.isPackaged
    ? detectPortableRoot()
    : null;
const IS_PORTABLE = Boolean(PORTABLE_ROOT);
const CONFIG_DIR = PORTABLE_ROOT || HOME_CONFIG_DIR;
// 让同进程的内嵌 Node 服务也用这个目录（paths.ts 读该环境变量）
process.env.SIMPLEWORK_CONFIG_DIR = CONFIG_DIR;

const STATE_FILE = path.join(CONFIG_DIR, 'desktop.json');
const LOG_FILE = path.join(CONFIG_DIR, 'desktop.log');

let win = null;
let handle = null;
let quitting = false;

log('main.cjs 已加载');

/* ------------------------------ 基础设施 ------------------------------ */

const PORTABLE_FILES = ['config.json', 'models.json', 'mcp.json', 'skills.json'];

/** 只复制「目标不存在」的文件，绝不覆盖用户已改过的配置 */
function copyFileIfMissing(src, dest) {
  try {
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      return true;
    }
  } catch (err) {
    log(`复制失败 ${src} -> ${dest}：${err.message}`);
  }
  return false;
}

/** 目录合并复制：不覆盖目标已有文件（用于 skills/、conversations/ 迁移） */
function mergeDir(src, dest) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
    return true;
  } catch (err) {
    log(`合并目录失败 ${src} -> ${dest}：${err.message}`);
    return false;
  }
}

/** 把旧的 ~/.simplework 迁移进便携目录（复制，不动原目录） */
function migrateLegacyConfig() {
  if (CONFIG_DIR === HOME_CONFIG_DIR || !fs.existsSync(HOME_CONFIG_DIR)) return;
  const moved = [];
  for (const f of [...PORTABLE_FILES, '.env', 'desktop.json']) {
    if (copyFileIfMissing(path.join(HOME_CONFIG_DIR, f), path.join(CONFIG_DIR, f))) moved.push(f);
  }
  if (mergeDir(path.join(HOME_CONFIG_DIR, 'skills'), path.join(CONFIG_DIR, 'skills'))) moved.push('skills/');
  if (mergeDir(path.join(HOME_CONFIG_DIR, 'conversations'), path.join(CONFIG_DIR, 'conversations'))) {
    moved.push('conversations/');
  }
  if (moved.length) log(`已从 ${HOME_CONFIG_DIR} 迁移：${moved.join('、')}`);
}

const ENV_TEMPLATE = [
  '# SimpleWork 本地密钥文件（只存在这台电脑上，不会上传任何地方）',
  '# 在应用左侧「设置」里填写即可自动写入本文件，也可手动编辑后重启应用。',
  '#',
  '# 举例：',
  '# DEEPSEEK_API_KEY=sk-xxxxxxxx',
  '# ZHIPU_API_KEY=xxxxxxxx',
  '# HUNYUAN_API_KEY=xxxxxxxx   （腾讯混元）',
  '# OPENAI_API_KEY=sk-xxxxxxxx',
  '',
].join('\n');

const WORKSPACE_README = [
  '# SimpleWork 工作区',
  '',
  'Agent 默认只在这个目录里读写文件。',
  '可以在应用菜单「文件 → 切换工作区」改成别的目录。',
  '',
  IS_PORTABLE ? '本目录与 exe 同级，整个文件夹复制到别处即可整体迁移。' : '',
  '',
].join('\n');

function ensureConfigDir() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(path.join(CONFIG_DIR, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(CONFIG_DIR, 'conversations'), { recursive: true });

    if (IS_PORTABLE) migrateLegacyConfig();

    // 出厂预置落地：缺哪个补哪个（这样 exe 同级就能直接看到、直接改）
    for (const f of PORTABLE_FILES) {
      if (copyFileIfMissing(path.join(FACTORY_CONFIG_DIR, f), path.join(CONFIG_DIR, f))) {
        log(`已生成默认配置：${f}`);
      }
    }

    const envFile = path.join(CONFIG_DIR, '.env');
    if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, ENV_TEMPLATE, 'utf8');
  } catch (err) {
    log(`初始化配置目录失败：${err.message}`);
  }
}

function log(line) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2), 'utf8');
  } catch (err) {
    log(`写入 desktop.json 失败：${err.message}`);
  }
}

/** 默认工作区：便携模式为 exe 同级的 workspace/，否则 <用户目录>/SimpleWork */
function defaultWorkspace() {
  if (PORTABLE_ROOT) return path.join(PORTABLE_ROOT, 'workspace');
  return path.join(os.homedir(), 'SimpleWork');
}

function currentWorkspace() {
  const st = readState();
  const ws = st.workspace || defaultWorkspace();
  try {
    fs.mkdirSync(ws, { recursive: true });
    if (!fs.existsSync(path.join(ws, 'README.md'))) {
      fs.writeFileSync(path.join(ws, 'README.md'), WORKSPACE_README, 'utf8');
    }
  } catch {
    /* ignore */
  }
  return ws;
}

/**
 * 打包后的 exe 不继承终端环境，PATH 里常常没有 node/npx，
 * 会导致 MCP（npx 启动）失败。这里尽力补齐常见安装位置。
 */
function ensureNodeInPath() {
  const extra = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm'),
    path.join(os.homedir(), 'scoop', 'shims'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
  const current = (process.env.PATH || '').split(path.delimiter);
  const missing = extra.filter((p) => {
    try {
      return fs.existsSync(p) && !current.some((c) => c.toLowerCase() === p.toLowerCase());
    } catch {
      return false;
    }
  });
  if (missing.length) {
    process.env.PATH = [...missing, ...current].join(path.delimiter);
    log(`已补齐 PATH：${missing.join(' ; ')}`);
  }
}

/* ------------------------------ 内嵌服务 ------------------------------ */

async function startServer(workspace) {
  const entry = path.join(PAYLOAD_DIR, 'dist', 'web', 'server.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`应用载荷缺失：${entry}\n请先在项目根目录执行 npm run desktop:build`);
  }
  const mod = await import(pathToFileURL(entry).href);
  return mod.startWebServer({
    port: 0, // 交由系统分配空闲端口，避免和已开的 CLI/网页版冲突
    host: '127.0.0.1',
    cwd: workspace,
    mcp: 'background',
    handleSignals: false,
    open: false,
    onStatus: (line) => log(`[server] ${line}`),
  });
}

/* ------------------------------ 窗口与菜单 ------------------------------ */

const SPLASH = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;
background:#f6f7f9;color:#1f2328;font-family:"Microsoft YaHei","Segoe UI",sans-serif}
.logo{width:56px;height:56px;border-radius:14px;background:#2563eb;color:#fff;display:flex;
align-items:center;justify-content:center;font-weight:800;font-size:20px;letter-spacing:.5px}
.t{font-size:15px;font-weight:600}
.d{font-size:12.5px;color:#6b7280}
</style></head><body><div class="logo">SW</div><div class="t">SimpleWork 正在启动</div>
<div class="d">正在准备本地引擎…</div></body></html>`;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'SimpleWork',
    autoHideMenuBar: false,
    icon: path.join(APP_DIR, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH)}`).catch((err) => {
    log(`启动页加载失败（继续）：${err.message}`);
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // 外部链接交给系统浏览器，不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL() || '';
    if (url !== current && /^https?:/i.test(url) && !url.startsWith('http://127.0.0.1')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

function buildMenu(workspace) {
  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('sw:new-session'),
        },
        { type: 'separator' },
        {
          label: '打开工作区目录',
          click: () => shell.openPath(workspace),
        },
        {
          label: '打开配置目录（~/.simplework）',
          click: () => shell.openPath(CONFIG_DIR),
        },
        {
          label: '打开 Key 配置文件（.env）',
          click: () => {
            const envFile = path.join(CONFIG_DIR, '.env');
            if (!fs.existsSync(envFile)) ensureConfigDir();
            shell.openPath(envFile);
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '工具',
      submenu: [
        {
          label: '切换工作区…',
          click: async () => {
            const r = await dialog.showOpenDialog(win, {
              title: '选择 SimpleWork 工作区目录',
              defaultPath: workspace,
              properties: ['openDirectory', 'createDirectory'],
            });
            if (r.canceled || !r.filePaths[0]) return;
            writeState({ workspace: r.filePaths[0] });
            log(`切换工作区 -> ${r.filePaths[0]}`);
            app.relaunch();
            app.exit(0);
          },
        },
        {
          label: '重新加载配置（模型 / MCP / Skill）',
          click: async () => {
            try {
              const port = handle?.port;
              if (!port) return;
              await fetch(`http://127.0.0.1:${port}/api/reload`, { method: 'POST' });
              win?.webContents.reload();
            } catch (err) {
              dialog.showErrorBox('重新加载失败', String(err));
            }
          },
        },
        { type: 'separator' },
        {
          label: '查看运行日志',
          click: () => {
            if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
            shell.openPath(LOG_FILE);
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 SimpleWork',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 SimpleWork',
              message: `SimpleWork Desktop ${app.getVersion()}`,
              detail: [
                '本地优先的轻量 Agent 工作台。',
                '',
                `工作区：${workspace}`,
                `配置目录：${CONFIG_DIR}${IS_PORTABLE ? '（便携：与 exe 同级）' : ''}`,
                `内嵌服务：http://127.0.0.1:${handle?.port ?? '-'}`,
                '',
                IS_PORTABLE ? '整个文件夹复制到 U 盘或另一台电脑即可完整迁移。' : '',
                '模型 / MCP / Skill 全部由本地配置驱动；',
                '对话内容只在你本机与所选的模型服务之间传输。',
              ].join('\n'),
              buttons: ['好'],
            });
          },
        },
        {
          label: '使用说明',
          click: () => {
            const readme = path.join(APP_DIR, 'README-DESKTOP.md');
            if (fs.existsSync(readme)) shell.openPath(readme);
            else dialog.showMessageBox(win, {
              type: 'info',
              title: '使用说明',
              message: '快速开始',
              detail:
                '1. 左侧「设置」里填入任一模型厂商的 API Key（如 DeepSeek）\n' +
                '2. 顶部选择供应商与模型\n' +
                '3. 直接对话；需要文件/命令能力时 Agent 会自动调用工具\n' +
                '4. MCP 与 Skill 在左侧对应标签页里开关和安装',
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ 生命周期 ------------------------------ */

ipcMain.handle('sw:info', () => ({
  version: app.getVersion(),
  workspace: currentWorkspace(),
  configDir: CONFIG_DIR,
  port: handle?.port ?? null,
  platform: process.platform,
  portable: IS_PORTABLE,
  exeDir: PORTABLE_ROOT,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
}));

ipcMain.handle('sw:open-path', async (_e, kind, extra) => {
  const target =
    kind === 'config' ? CONFIG_DIR
    : kind === 'env' ? path.join(CONFIG_DIR, '.env')
    : kind === 'conversations' ? path.join(CONFIG_DIR, 'conversations')
    : kind === 'path' && extra ? String(extra)
    : currentWorkspace();
  if (kind === 'env' && !fs.existsSync(target)) ensureConfigDir();
  return shell.openPath(target);
});

ipcMain.handle('sw:pick-workspace', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作区目录',
    defaultPath: currentWorkspace(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  writeState({ workspace: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle('sw:restart', () => {
  app.relaunch();
  app.exit(0);
});

/** 页面加载重试：网络服务偶发崩溃时自动恢复 */
async function loadWithRetry(url, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await win.loadURL(url);
      return;
    } catch (err) {
      log(`页面加载失败（第 ${i}/${attempts} 次）：${err.message}`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureConfigDir();
    ensureNodeInPath();
    const workspace = currentWorkspace();
    log('--- 启动 ---');
    log(`workspace=${workspace}`);
    log(`configDir=${CONFIG_DIR}${IS_PORTABLE ? '（便携模式，exe 同级）' : ''}`);

    createWindow();

    try {
      handle = await startServer(workspace);
      log(`内嵌服务已启动：${handle.url}`);
      await loadWithRetry(handle.url);
      buildMenu(workspace);
      win.show();
    } catch (err) {
      log(`启动失败：${err.stack || err.message}`);
      dialog.showErrorBox(
        'SimpleWork 启动失败',
        `${err.message}\n\n日志：${LOG_FILE}`,
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async (event) => {
    if (quitting) return;
    quitting = true;
    if (handle) {
      event.preventDefault();
      try {
        await handle.close();
        log('内嵌服务已关闭');
      } catch (err) {
        log(`关闭服务出错：${err.message}`);
      }
      app.exit(0);
    }
  });
}
