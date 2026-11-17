'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 只向页面暴露最小能力集合：查询运行信息、打开目录、切换工作区、重启。
 * 页面拿不到 Node，也拿不到任意 IPC 通道。
 */
contextBridge.exposeInMainWorld('simpleworkDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('sw:info'),
  openPath: (kind, extra) => ipcRenderer.invoke('sw:open-path', kind, extra),
  pickWorkspace: () => ipcRenderer.invoke('sw:pick-workspace'),
  restart: () => ipcRenderer.invoke('sw:restart'),
  onNewSession: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('sw:new-session', listener);
    return () => ipcRenderer.removeListener('sw:new-session', listener);
  },
});
