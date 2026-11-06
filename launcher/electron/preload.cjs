/**
 * electron/preload.cjs — 安全 IPC 桥接层
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcnext', {
  // 仓库
  listClients: () => ipcRenderer.invoke('repo:listClients'),
  listServers: () => ipcRenderer.invoke('repo:listServers'),
  listLoaderFiles: (mc) => ipcRenderer.invoke('repo:listLoaderFiles', mc),
  // 清单/版本
  fetchManifest: () => ipcRenderer.invoke('manifest:fetch'),
  getVersionJson: (id) => ipcRenderer.invoke('version:getJson', id),
  // 下载
  startDownload: (task) => ipcRenderer.invoke('download:start', task),
  onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (_e, p) => cb(p)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, p) => cb(p)),
  onDownloadError: (cb) => ipcRenderer.on('download:error', (_e, p) => cb(p)),
  // 游戏
  launchGame: (opts) => ipcRenderer.invoke('game:launch', opts),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  gameStatus: () => ipcRenderer.invoke('game:status'),
  onGameLog: (cb) => ipcRenderer.on('game:log', (_e, l) => cb(l)),
  onGameExit: (cb) => ipcRenderer.on('game:exit', (_e, r) => cb(r)),
  // 服务端
  detectServer: (p) => ipcRenderer.invoke('server:detect', p),
  deployServer: (o) => ipcRenderer.invoke('server:deploy', o),
  startServer: (o) => ipcRenderer.invoke('server:start', o),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  serverCommand: (c) => ipcRenderer.invoke('server:command', c),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  onServerLog: (cb) => ipcRenderer.on('server:log', (_e, l) => cb(l)),
  onServerExit: (cb) => ipcRenderer.on('server:exit', (_e, r) => cb(r)),
  // 对话框
  pickJar: () => ipcRenderer.invoke('dialog:pickJar'),
  pickFile: (exts) => ipcRenderer.invoke('dialog:pickFile', exts),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  // 模块二：版本隔离
  instanceList: () => ipcRenderer.invoke('instance:list'),
  instanceCreate: (o) => ipcRenderer.invoke('instance:create', o),
  instanceInfo: (id) => ipcRenderer.invoke('instance:info', id),
  instanceArgs: (id, extras) => ipcRenderer.invoke('instance:args', id, extras),
  instanceRemove: (id) => ipcRenderer.invoke('instance:remove', id),
  // 模块二：账号（微软 OAuth2 / Authlib-Injector）
  authList: () => ipcRenderer.invoke('auth:list'),
  authDeviceStart: () => ipcRenderer.invoke('auth:deviceStart'),
  authDeviceComplete: (id) => ipcRenderer.invoke('auth:deviceComplete', id),
  authlibLogin: (o) => ipcRenderer.invoke('auth:authlibLogin', o),
  authlibMeta: (root) => ipcRenderer.invoke('auth:authlibMeta', root),
  authRemove: (uuid) => ipcRenderer.invoke('auth:remove', uuid),
  authLaunchArgs: (uuid) => ipcRenderer.invoke('auth:launchArgs', uuid),
  // 模块二：并发下载 / 整合包
  downloadBatch: (o) => ipcRenderer.invoke('download:batch', o),
  onDownloadBatch: (cb) => ipcRenderer.on('download:batch', (_e, p) => cb(p)),
  modpackParse: (p) => ipcRenderer.invoke('modpack:parse', p),
  modpackInstall: (o) => ipcRenderer.invoke('modpack:install', o),
  onModpackProgress: (cb) => ipcRenderer.on('modpack:progress', (_e, p) => cb(p)),
  // 模块三：本地 Jar / 彩色控制台
  localJarInspect: (p) => ipcRenderer.invoke('localJar:inspect', p),
  localJarPlan: (o) => ipcRenderer.invoke('localJar:plan', o),
  consoleHighlight: (raw) => ipcRenderer.invoke('console:highlight', raw),
  consoleHighlightBatch: (lines) => ipcRenderer.invoke('console:highlightBatch', lines),
  consoleParse: (raw) => ipcRenderer.invoke('console:parse', raw),
  // 模块四：崩溃分析 / 日志净化
  crashAnalyze: (o) => ipcRenderer.invoke('crash:analyze', o),
  crashClean: (text) => ipcRenderer.invoke('crash:clean', text),
  crashReadLatestLog: (dir) => ipcRenderer.invoke('crash:readLatestLog', dir),
  // 移动端配置导出 / 真实 Release 链接
  mobileExport: (cfg) => ipcRenderer.invoke('mobile:export', cfg),
  releaseInfo: () => ipcRenderer.invoke('app:release'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // 平台信息
  platform: process.platform,
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0
});
