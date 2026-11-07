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
  // 0.6.0 模块二：设备码真流程（申请 → 后台轮询 → 状态订阅 → 取消）
  authDeviceStart: (opts) => ipcRenderer.invoke('auth:deviceStart', opts),
  authDeviceBegin: (id) => ipcRenderer.invoke('auth:deviceBegin', id),
  authDeviceStatus: (id) => ipcRenderer.invoke('auth:deviceStatus', id),
  authDeviceCancel: (id) => ipcRenderer.invoke('auth:deviceCancel', id),
  authDeviceComplete: (id) => ipcRenderer.invoke('auth:deviceComplete', id),
  onAuthDevice: (cb) => ipcRenderer.on('auth:deviceStatus', (_e, p) => cb(p)),
  authCurrent: () => ipcRenderer.invoke('auth:current'),
  authSelect: (uuid) => ipcRenderer.invoke('auth:select', uuid),
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
  // 模块一：Java 运行环境智能管家
  javaScan: () => ipcRenderer.invoke('java:scan'),
  javaRequired: (mcVersion) => ipcRenderer.invoke('java:required', mcVersion),
  javaSelect: (mcVersion, extraRoots) => ipcRenderer.invoke('java:select', { mcVersion, extraRoots }),
  javaInstall: (major, root) => ipcRenderer.invoke('java:install', { major, root }),
  onJavaProgress: (cb) => ipcRenderer.on('java:progress', (_e, p) => cb(p)),
  // 模块二：一键联机大厅
  lanBinaries: () => ipcRenderer.invoke('lan:binaries'),
  lanVerify: (corePath) => ipcRenderer.invoke('lan:verify', corePath),
  lanCreate: (opts) => ipcRenderer.invoke('lan:create', opts),
  lanJoin: (inviteCode, opts) => ipcRenderer.invoke('lan:join', { inviteCode, ...opts }),
  lanStart: (room, opts) => ipcRenderer.invoke('lan:start', { room, ...opts }),
  lanStop: () => ipcRenderer.invoke('lan:stop'),
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  lanListRooms: () => ipcRenderer.invoke('lan:listRooms'),
  // 模块三：本地世界（存档）智能管家
  worldList: (gameDir) => ipcRenderer.invoke('world:list', { gameDir }),
  worldInspect: (worldDir, gameDir) => ipcRenderer.invoke('world:inspect', { worldDir, gameDir }),
  worldBackups: (root, world) => ipcRenderer.invoke('world:backups', { root, world }),
  worldBackup: (gameDir, world, opts) => ipcRenderer.invoke('world:backup', { gameDir, world, ...opts }),
  worldRestore: (gameDir, world, zipPath, root) => ipcRenderer.invoke('world:restore', { gameDir, world, zipPath, root }),
  // 模块四：3D 皮肤渲染与外观定制
  skinInspectFile: (filePath) => ipcRenderer.invoke('skin:inspectFile', filePath),
  skinFetchFromAuthlib: (apiRoot, playerName) => ipcRenderer.invoke('skin:fetchFromAuthlib', { apiRoot, playerName }),
  skinDownloadImage: (url) => ipcRenderer.invoke('skin:downloadImage', { url }),
  skinUpload: (opts) => ipcRenderer.invoke('skin:upload', opts),
  // 模块三（0.4.0）：下载源策略 / 重试事件
  downloadSources: () => ipcRenderer.invoke('download:sources'),
  onDownloadRetry: (cb) => ipcRenderer.on('download:retry', (_e, p) => cb(p)),
  // 模块一（0.4.0）：真实网络配置向导 / 容错诊断
  netGuide: () => ipcRenderer.invoke('net:guide'),
  netDiagnose: (payload) => ipcRenderer.invoke('net:diagnose', payload || {}),
  // 模块二（0.4.0）：模组与资源包智能管家
  modsList: (o) => ipcRenderer.invoke('mods:list', o || {}),
  modsConflicts: (o) => ipcRenderer.invoke('mods:conflicts', o || {}),
  modsToggle: (o) => ipcRenderer.invoke('mods:toggle', o),
  modsPacks: (o) => ipcRenderer.invoke('mods:packs', o || {}),
  modsShaderCheck: (o) => ipcRenderer.invoke('mods:shaderCheck', o || {}),
  modsPickPack: () => ipcRenderer.invoke('mods:pickPack'),
  modsImport: (o) => ipcRenderer.invoke('mods:import', o),
  // 模块二（0.5.0）：整合包一键导出 / 分享 / 拖拽导入 / 依赖预检
  modpackParseBuffer: (base64) => ipcRenderer.invoke('modpack:parseBuffer', { base64 }),
  modpackDescribe: (plan) => ipcRenderer.invoke('modpack:describe', plan),
  modpackPreflight: (plan) => ipcRenderer.invoke('modpack:preflight', plan),
  modpackExport: (o) => ipcRenderer.invoke('modpack:export', o),
  modpackReadManifest: (p) => ipcRenderer.invoke('modpack:readManifest', p),
  // 模块一（0.5.0）：动态背景 / 极客 JVM 面板
  appearancePickImage: () => ipcRenderer.invoke('appearance:pickImage'),
  appearanceValidate: (cfg) => ipcRenderer.invoke('appearance:validate', cfg),
  jvmProfiles: () => ipcRenderer.invoke('jvm:profiles'),
  jvmPreview: (o) => ipcRenderer.invoke('jvm:preview', o),
  // 模块三（0.6.0）：JVM 实时监控 / 一键调优
  jvmMonitorStatus: () => ipcRenderer.invoke('jvm:monitorStatus'),
  jvmRecommend: () => ipcRenderer.invoke('jvm:recommend'),
  onJvmMetrics: (cb) => ipcRenderer.on('jvm:metrics', (_e, p) => cb(p)),
  // 模块四（0.6.0）：Modrinth 资源中心
  modrinthSearch: (q) => ipcRenderer.invoke('modrinth:search', q),
  modrinthVersions: (q) => ipcRenderer.invoke('modrinth:versions', q),
  modrinthInstall: (o) => ipcRenderer.invoke('modrinth:install', o),
  onModrinthProgress: (cb) => ipcRenderer.on('modrinth:progress', (_e, p) => cb(p)),
  // 模块五（0.6.0）：自动更新（latest.yml / 静默下载 / Android 检查）
  updateCheck: (o) => ipcRenderer.invoke('update:check', o),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateDownload: (o) => ipcRenderer.invoke('update:download', o),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  // 平台信息
  platform: process.platform,
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0
});
