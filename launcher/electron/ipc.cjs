/**
 * electron/ipc.cjs — IPC 处理器注册（main.cjs 与测试共用）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const { GameLauncher, classifyLine, stripAnsi } = require('../engine/launcher');
const { deployServer, detectJarKind } = require('../engine/serverDeploy');
const { downloadFile, fetchJson } = require('../engine/http');
const { OFFICIAL, SOURCE_POLICY } = require('../engine/sources');
const { buildClasspath } = require('../engine/library');
// —— 重构后的四大模块引擎 ——
const isolation = require('../engine/isolation.cjs');
const msAuth = require('../engine/auth/microsoft.cjs');
const authlib = require('../engine/auth/authlib.cjs');
const { downloadBatch } = require('../engine/downloader.cjs');
const modpack = require('../engine/modpack.cjs');
const localJar = require('../engine/localJar.cjs');
const crashAnalyzer = require('../engine/crash/analyzer.cjs');
const logCleaner = require('../engine/crash/logCleaner.cjs');
const { highlight, parseLogLine } = require('../engine/server/console.cjs');
// —— 生态扩展模块（0.3.0）——
const javaMgr = require('../engine/java/manager.cjs');
const lanRoom = require('../engine/net/room.cjs');
const worldMgr = require('../engine/world/manager.cjs');
const skinMgr = require('../engine/skin/manager.cjs');
// —— 生态扩展模块（0.4.0）——
const modsMgr = require('../engine/mods/manager.cjs');
const netGuide = require('../engine/net/guide.cjs');
// —— 极致体验模块（0.5.0）——
const appearance = require('../engine/appearance.cjs');
const modpackExport = require('../engine/modpackExport.cjs');
// —— 商业级模块（0.6.0）——
const { DeviceFlowManager } = require('../engine/auth/deviceFlow.cjs');
const jvmMonitorMod = require('../engine/jvm/monitor.cjs');
const modrinth = require('../engine/modrinth/client.cjs');
const updater = require('../engine/updater.cjs');
const releaseCfg = require('../config/release.json');

const os = require('os');
const HOME = os.homedir();
const LAUNCHER_DIR = path.join(HOME, '.mc-next');
const GAME_DIR = path.join(LAUNCHER_DIR, 'game');
const LIBRARIES_DIR = path.join(LAUNCHER_DIR, 'libraries');
const ASSETS_DIR = path.join(LAUNCHER_DIR, 'assets');
const REPO_CLIENT = '/workspace/MC正式版客户端';
const REPO_SERVER = '/workspace/MC正式版服务端';

/** 0.6.0 模块二：设备码会话管理器（模块级单例，后台轮询跨 IPC 调用持续存活） */
const authFlow = new DeviceFlowManager({
  storeFile: path.join(LAUNCHER_DIR, 'accounts.json'),
  currentFile: path.join(LAUNCHER_DIR, 'current-account.json'),
  mock: process.env.MCNEXT_AUTH_MOCK === '1',
  onStatus: (view) => send('auth:deviceStatus', view)
});

/** 0.6.0 模块三：当前游戏的 JVM 监控器（进程级单例，退出自动停止） */
let jvmMonitor = null;
/** 0.6.0 模块五：后台静默下载状态（跨 IPC 调用保持） */
const updateState = { downloading: false, last: null };

/** 运行状态（模块级单例） */
const state = { game: null, server: null, mainWindow: null };

/**
 * 0.6.0 模块一：统一 IPC handler 注册表。
 * 桌面端照常 ipcMain.handle；Android 大一统 UI 的 remote 指令通过
 * /api/rpc → dispatchChannel() 复用**同一个真实 handler**，不重写、不伪造。
 * 只有 registerIpc 执行过（即 Electron 主进程已启动）后表中才有条目。
 */
const HANDLERS = new Map();
function handle(channel, fn) {
  HANDLERS.set(channel, fn);
  return ipcMain.handle(channel, fn);
}

/** 按 channel 直接调用已注册的真实 handler（供远程 RPC / 测试复用） */
async function dispatchChannel(channel, ...args) {
  const fn = HANDLERS.get(channel);
  if (!fn) throw new Error(`未注册的 IPC channel: ${channel}`);
  return fn(null, ...args);
}
function hasChannel(channel) { return HANDLERS.has(channel); }
/** 联机大厅管理器（长生命周期，跨 IPC 调用保持同一实例） */
const netState = { manager: null };
function getRoomManager() {
  if (!netState.manager) netState.manager = new lanRoom.RoomManager();
  return netState.manager;
}

/** 0.4.0：解析模组/资源包所在 gameDir（支持版本隔离实例），默认回落到主游戏目录 */
function resolveGameDir(o) {
  const opt = o || {};
  if (opt.gameDir) {
    const p = path.resolve(opt.gameDir);
    if (!path.isAbsolute(p)) throw new Error('gameDir 必须是绝对路径');
    return p;
  }
  if (opt.instanceId) return isolation.gameDirOf(LAUNCHER_DIR, isolation.safeId(opt.instanceId));
  return GAME_DIR;
}

/** 日志环形缓冲（远程控制台 /api/logs 用，最近 500 条） */
const logBuf = [];
function pushLog(level, text) {
  logBuf.push({ t: Date.now(), level, text });
  if (logBuf.length > 500) logBuf.shift();
}

function send(channel, payload) {
  if (channel === 'game:log' || channel === 'server:log') pushLog(payload.level || 'info', payload.text || '');
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, payload);
  }
}

/** 启动游戏核心逻辑（IPC 与远程控制服务共用） */
async function launchGameCore(opts) {
  try {
    if (state.game && state.game.running) return { ok: false, error: '游戏已在运行' };
    const vj = opts.versionJson;
    // 模块一：Java 管家自动分配——未显式指定 javaPath 时，扫描本机并匹配 MC 版本所需 Java
    if (!opts.javaPath) {
      try {
        const local = javaMgr.scanLocalJava({ extraRoots: [] });
        const sel = javaMgr.selectJava(local.list, opts.versionId);
        if (sel.ok) opts.javaPath = sel.java.path;
      } catch { /* 扫描失败时退回默认 java */ }
    }
    const gameJar = path.join(REPO_CLIENT, `${opts.versionId}.jar`);
    const env = {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux',
      arch: process.arch === 'ia32' ? 'x86' : process.arch,
      features: {}
    };
    const cp = buildClasspath(vj, { repoRoot: LIBRARIES_DIR, env, gameJarPath: gameJar, extraJars: opts.extraJars || [] });

    // 自动补全缺失依赖（多源降级：官方 → BMCLAPI）
    for (const m of cp.missing) {
      if (!m.url) continue;
      send('game:log', { level: 'info', text: `[MC-Next] 补全依赖 ${m.path}` });
      await downloadFile(m.url, m.local, { expectedSha1: m.sha1 });
    }

    // 模块一（0.5.0）：极客 JVM 面板 —— 推荐预设 + 自定义参数合成，内存由界面统一托管
    const jvm = appearance.mergeLaunchJvm({
      profileId: opts.jvmProfileId,
      extraJvmArgsText: opts.extraJvmArgsText,
      extraJvmArgs: opts.extraJvmArgs,
      minMemory: opts.minMemory,
      maxMemory: opts.maxMemory
    });
    for (const w of jvm.issues.filter(i => i.severity === 'error')) {
      send('game:log', { level: 'warn', text: `[MC-Next] 已忽略非法 JVM 参数：${w.message}` });
    }
    if (jvm.jvmArgs.length) {
      send('game:log', { level: 'info', text: `[MC-Next] 附加 ${jvm.jvmArgs.length} 个自定义 JVM 参数${jvm.profileId ? `（预设 ${jvm.profileId}）` : ''}` });
    }

    // 0.6.0 模块三：自动注入真实 GC 日志参数（用户已自行配置 GC 日志时不覆盖）
    const extraJvmArgs = jvm.jvmArgs.slice();
    const hasGcLogging = extraJvmArgs.some(a => /^-Xlog|gc/i.test(a));
    if (!hasGcLogging) extraJvmArgs.push(...jvmMonitorMod.gcArgsForMcVersion(opts.versionId));
    if (extraJvmArgs.length > jvm.jvmArgs.length) {
      send('game:log', { level: 'info', text: `[MC-Next] 已启用 GC 日志：${extraJvmArgs.slice(jvm.jvmArgs.length).join(' ')}` });
    }

    const launcher = new GameLauncher({
      versionJson: vj,
      classpath: cp.classpath.join(process.platform === 'win32' ? ';' : ':'),
      nativesDir: path.join(LAUNCHER_DIR, 'natives', opts.versionId),
      gameDir: GAME_DIR,
      assetsDir: ASSETS_DIR,
      assetIndexId: vj.assetIndex ? vj.assetIndex.id : 'legacy',
      javaPath: opts.javaPath || 'java',
      minMemory: jvm.minMemory,
      maxMemory: jvm.maxMemory,
      playerName: opts.playerName || 'Player',
      uuid: opts.uuid,
      versionId: opts.versionId,
      versionType: 'MC-Next',
      extraJvmArgs,
      env
    });
    launcher.on('log', l => send('game:log', l));
    launcher.on('exit', r => { state.game = null; send('game:exit', r); });
    launcher.on('error', e => send('game:log', { level: 'error', text: String(e) }));
    state.game = launcher;
    launcher.launch();

    // 0.6.0 模块三：挂载 JVM 监控。GameLauncher 已把 stdout/stderr 汇成 log 事件，
    // 监控器逐行解析 GC 日志，并按 1s 采样 /proc/<pid>/status 的 VmRSS 推给性能小雷达。
    if (jvmMonitor) jvmMonitor.stop();
    jvmMonitor = new jvmMonitorMod.JvmMonitor({ pid: launcher.process && launcher.process.pid });
    jvmMonitor.on('sample', (s) => send('jvm:metrics', s));
    jvmMonitor.attach(launcher);

    return { ok: true, missingCount: cp.missing.length, monitorPid: jvmMonitor.pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerIpc(mainWindow) {
  state.mainWindow = mainWindow;

  // ---------- 本地仓库 ----------
  handle('repo:listClients', async () => {
    try {
      return fs.readdirSync(REPO_CLIENT).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  handle('repo:listServers', async () => {
    try {
      return fs.readdirSync(REPO_SERVER).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  handle('repo:listLoaderFiles', async (evt, mcVersion) => {
    const out = [];
    const dir = path.join('/workspace/模组加载器', mcVersion);
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) out.push(f);
    return out;
  });

  // ---------- 版本清单 ----------
  handle('manifest:fetch', async () => {
    return fetchJson(OFFICIAL.versionManifest, { timeoutMs: 30000 });
  });

  handle('version:getJson', async (evt, versionId) => {
    const cache = path.join(LAUNCHER_DIR, 'versions', `${versionId}.json`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
    const j = await fetchJson(`https://bmclapi2.bangbang93.com/version/${versionId}/json`, { timeoutMs: 30000 });
    fs.writeFileSync(cache, JSON.stringify(j));
    return j;
  });

  // ---------- 下载（0.4.0：BMCLAPI 首选 + 指数退避 + 重试事件） ----------
  handle('download:sources', async () => SOURCE_POLICY);
  handle('download:start', async (evt, { id, url, dest, sha1, size }) => {
    try {
      const r = await downloadFile(url, dest, {
        expectedSha1: sha1,
        preferMirror: true,
        onRetry: (info) => send('download:retry', { id, ...info }),
        onProgress: (received, total) => send('download:progress', { id, received, total })
      });
      send('download:done', { id, sha1: r.sha1, size: r.size });
      return { ok: true, ...r };
    } catch (e) {
      send('download:error', { id, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // ---------- 游戏启动 ----------
  handle('game:launch', async (evt, opts) => launchGameCore(opts));

  handle('game:stop', async () => {
    if (state.game) { await state.game.kill(); state.game = null; return { ok: true }; }
    return { ok: false, error: '无运行中的游戏' };
  });

  handle('game:status', async () => !!(state.game && state.game.running));

  // ---------- 服务端 ----------
  handle('server:detect', async (evt, jarPath) => detectJarKind(jarPath));

  handle('server:deploy', async (evt, { jarPath, workDir, memory, javaPath }) => {
    try {
      const r = await deployServer(jarPath, workDir, { memory: memory || '4G', javaPath: javaPath || 'java' });
      // Fabric launcherMeta 可用时记录 -cp 启动信息（asm/sponge-mixin 必须入 classpath）
      state.serverLaunch = (r.launchClasspath && r.launchClasspath.length)
        ? { workDir, launchClasspath: r.launchClasspath, mainClass: 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher' }
        : null;
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('server:start', async (evt, { workDir, coreJar, memory, javaPath }) => {
    try {
      if (state.server && state.server.running) return { ok: false, error: '服务端已在运行' };
      const { spawn } = require('child_process');
      const info = state.serverLaunch;
      let args;
      if (info && info.launchClasspath && info.workDir === workDir) {
        args = ['-Xms1G', `-Xmx${memory || '4G'}`, '-cp', info.launchClasspath.join(':'), info.mainClass, 'nogui'];
      } else {
        const jar = path.join(workDir, coreJar);
        args = ['-Xms1G', `-Xmx${memory || '4G'}`, '-jar', jar, 'nogui'];
      }
      const child = spawn(javaPath || 'java', args, { cwd: workDir });
      state.server = child;
      const onData = (buf) => {
        const text = buf.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (line) send('server:log', { level: classifyLine(line), text: stripAnsi(line) });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', e => send('server:log', { level: 'error', text: String(e) }));
      child.on('exit', (code, signal) => { state.server = null; send('server:exit', { code, signal }); });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('server:stop', async () => {
    if (state.server) {
      state.server.kill('SIGTERM');
      state.server = null;
      return { ok: true };
    }
    return { ok: false, error: '无运行中的服务端' };
  });

  handle('server:command', async (evt, cmd) => {
    if (state.server && state.server.stdin && state.server.stdin.writable) {
      state.server.stdin.write(cmd + '\n');
      return { ok: true };
    }
    return { ok: false, error: '服务端未运行' };
  });

  handle('server:status', async () => !!(state.server && !state.server.killed));

  // ---------- 对话框 ----------
  handle('dialog:pickJar', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Jar 文件',
      filters: [{ name: 'Jar', extensions: ['jar'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:pickFile', async (evt, exts = ['mrpack', 'zip', 'json']) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择整合包 / 配置文件',
      filters: [{ name: '整合包', extensions: exts }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ==================== 模块二：极致版本隔离 ====================
  handle('instance:list', async () => isolation.listInstances(LAUNCHER_DIR));
  handle('instance:create', async (evt, o) =>
    isolation.ensureInstance(LAUNCHER_DIR, o.id, {
      name: o.name, gameVersion: o.gameVersion, loader: o.loader
    }));
  handle('instance:info', async (evt, id) => isolation.instanceInfo(LAUNCHER_DIR, id));
  handle('instance:args', async (evt, id, extras) =>
    isolation.buildInstanceArgs(LAUNCHER_DIR, id, extras || {}));
  handle('instance:remove', async (evt, id) => isolation.removeInstance(LAUNCHER_DIR, id));

  // ============ 0.6.0 模块二：微软正版 OAuth2 设备码真流程 + Authlib-Injector ============
  const ms = authFlow.authenticator;   // 复用同一账号仓库（launchArgs / remove / ensureValid）
  const authlibFile = path.join(LAUNCHER_DIR, 'accounts-authlib.json');
  const readAuthlib = () => {
    try { return JSON.parse(fs.readFileSync(authlibFile, 'utf8')); } catch { return []; }
  };
  const writeAuthlib = (list) => {
    fs.mkdirSync(LAUNCHER_DIR, { recursive: true });
    fs.writeFileSync(authlibFile, JSON.stringify(list, null, 2), { mode: 0o600 });
  };

  handle('auth:list', async () => {
    // 只回传展示所需字段，令牌永不出主进程
    const microsoft = authFlow.list();
    const third = readAuthlib().map(a => ({ ...a, type: 'authlib', hasRefresh: false }));
    return [...microsoft, ...third];
  });

  // 第 1 步：申请设备码（真实 login.microsoftonline.com；mock:true 为明确标注的离线演示）
  handle('auth:deviceStart', async (evt, opts = {}) => authFlow.start(opts || {}));
  // 第 2 步：后台死循环轮询（立即返回，不阻塞渲染层）
  handle('auth:deviceBegin', async (evt, id) => authFlow.beginPolling(id));
  handle('auth:deviceStatus', async (evt, id) => authFlow.status(id));
  handle('auth:deviceCancel', async (evt, id) => authFlow.cancel(id));
  // 兼容旧 UI：发起并等待完成
  handle('auth:deviceComplete', async (evt, id) => authFlow.complete(id));
  // 主页正版玩家卡片 / 账号切换
  handle('auth:current', async () => authFlow.current());
  handle('auth:select', async (evt, uuid) => authFlow.select(uuid));

  handle('auth:authlibLogin', async (evt, { apiRoot, username, password }) => {
    const account = await authlib.authenticate(apiRoot, { username, password });
    const list = readAuthlib().filter(a => !(a.uuid === account.uuid && a.apiRoot === apiRoot));
    list.push(account);
    writeAuthlib(list);
    return { uuid: account.uuid, name: account.name, type: 'authlib', apiRoot };
  });

  handle('auth:authlibMeta', async (evt, apiRoot) => authlib.fetchMetadata(apiRoot));
  handle('auth:remove', async (evt, uuid) => {
    ms.deleteAccount(uuid);
    writeAuthlib(readAuthlib().filter(a => a.uuid !== uuid));
    return { ok: true };
  });
  handle('auth:launchArgs', async (evt, uuid) => {
    const a = ms.listAccounts().find(x => x.uuid === uuid);
    if (a) return msAuth.toLaunchArgs(await ms.ensureValid(a));
    const b = readAuthlib().find(x => x.uuid === uuid);
    if (b) return authlib.toLaunchArgs(b);
    throw new Error('账号不存在');
  });

  // ==================== 模块二：多源并发下载 ====================
  handle('download:batch', async (evt, { tasks, concurrency, preferMirror, backoffBaseMs }) => {
    return downloadBatch(tasks, {
      concurrency: concurrency || 8,
      preferMirror: preferMirror !== false,
      ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
      onEvent: (e) => send('download:batch', e)
    });
  });

  // ==================== 模块二：整合包一键安装（0.5.0 带依赖预检硬拦截） ====================
  handle('modpack:parse', async (evt, filePath) => modpack.parseModpack(filePath));
  // 拖拽导入：接收 base64 文件字节（避免依赖 file.path 在 WebView / Capacitor 下不可用）
  handle('modpack:parseBuffer', async (evt, { base64 } = {}) => {
    if (!base64 || typeof base64 !== 'string') return { ok: false, error: '拖拽文件为空' };
    try {
      const plan = modpack.parseModpack(Buffer.from(base64, 'base64'));
      return { ok: true, plan, describe: modpackExport.describeModpack(plan) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('modpack:describe', async (evt, plan) => {
    try { return { ok: true, ...modpackExport.describeModpack(plan) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('modpack:preflight', async (evt, plan) => {
    try { return { ok: true, ...modpackExport.preflightImport(plan) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('modpack:install', async (evt, { plan, instanceId, apiKey, force } = {}) => {
    try {
      return await modpackExport.installWithPreflight({
        plan, root: LAUNCHER_DIR, instanceId,
        apiKey: apiKey || process.env.MCNEXT_CURSE_API_KEY,
        force: !!force,
        onEvent: (e) => send('modpack:progress', e)
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块二（0.5.0）：整合包一键导出 / 分享 ====================
  handle('modpack:export', async (evt, { instanceId, name, versionId, includePacks } = {}) => {
    try {
      const r = dialog.showSaveDialogSync(mainWindow, {
        title: '导出整合包（.mrpack）',
        defaultPath: path.join(HOME, `${String(name || instanceId || 'modpack').replace(/[^\w.-]+/g, '-')}.mrpack`),
        filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack', 'zip'] }]
      });
      if (!r) return { ok: false, error: '已取消' };
      const out = modpackExport.exportInstance(LAUNCHER_DIR, instanceId, {
        outPath: r, name, versionId, includePacks
      });
      // 不把大 buffer 传回渲染进程
      const { buffer, ...safe } = out;
      return safe;
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('modpack:readManifest', async (evt, filePath) => {
    try {
      const m = modpackExport.readExportManifest(filePath);
      return m ? { ok: true, manifest: m } : { ok: false, error: '该包不含 MC-Next 自描述清单' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块三：本地 Jar 智能解析与合并 ====================
  handle('localJar:inspect', async (evt, p) => localJar.inspectJar(p));
  handle('localJar:plan', async (evt, o) => localJar.buildLocalLaunchPlan({
    gameJar: o.gameJar,
    loaderJars: o.loaderJars || [],
    libraries: o.libraries || [],
    outDir: o.outDir || path.join(LAUNCHER_DIR, 'local', o.id || 'default')
  }));

  // ==================== 模块三：硬核终端日志（彩色高亮） ====================
  handle('console:highlight', async (evt, raw) => highlight(raw));
  handle('console:highlightBatch', async (evt, lines) =>
    (lines || []).map(l => highlight(String(l))));
  handle('console:parse', async (evt, raw) => parseLogLine(raw));

  // ==================== 模块四：崩溃分析与日志净化 ====================
  handle('crash:analyze', async (evt, o) => crashAnalyzer.analyzeCrash(o));
  handle('crash:clean', async (evt, text) => {
    const r = logCleaner.cleanLatestLog(text, { maxLines: 120 });
    return { ...r, report: logCleaner.toPlainTextReport(r) };
  });
  handle('crash:readLatestLog', async (evt, gameDir) => {
    const p = path.join(gameDir || GAME_DIR, 'logs', 'latest.log');
    if (!fs.existsSync(p)) return { ok: false, error: `未找到 ${p}` };
    return { ok: true, path: p, text: fs.readFileSync(p, 'utf8') };
  });

  // ==================== 移动端启动配置导出（供原生 APK 的 launch.json） ====================
  handle('mobile:export', async (evt, cfg) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled) return { ok: false, error: '已取消' };
    const dest = path.join(r.filePaths[0], 'launch.json');
    fs.writeFileSync(dest, JSON.stringify(cfg, null, 2));
    return { ok: true, path: dest };
  });

  // ==================== 真实 GitHub Release 绝对链接 ====================
  handle('app:release', async () => {
    const base = `${releaseCfg.repo}/releases/download/${releaseCfg.tag}`;
    return {
      page: `${releaseCfg.repo}/releases/tag/${releaseCfg.tag}`,
      repo: releaseCfg.repo, tag: releaseCfg.tag,
      appImage: `${base}/${releaseCfg.assets.appImage}`,
      tarGz: `${base}/${releaseCfg.assets.tarGz}`,
      apk: `${base}/${releaseCfg.assets.apk}`,
      source: `${base}/${releaseCfg.assets.source}`,
      mirrorPrefix: releaseCfg.mirror || '',
      mirrorAppImage: `${releaseCfg.mirror || ''}${base}/${releaseCfg.assets.appImage}`,
      mirrorApk: `${releaseCfg.mirror || ''}${base}/${releaseCfg.assets.apk}`
    };
  });
  handle('app:openExternal', async (evt, url) => {
    if (!/^https:\/\//.test(url)) return { ok: false, error: '仅允许 https 外链' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // ==================== 模块一：Java 运行环境智能管家 ====================
  handle('java:scan', async (evt, { extraRoots } = {}) => {
    const r = javaMgr.scanLocalJava({ extraRoots: extraRoots || [] });
    return { ok: true, ...r };
  });
  handle('java:required', async (evt, mcVersion) => javaMgr.requiredJava(mcVersion));
  handle('java:select', async (evt, { mcVersion, extraRoots }) => {
    const local = javaMgr.scanLocalJava({ extraRoots: extraRoots || [] });
    const picked = javaMgr.selectJava(local.list, mcVersion);
    return { ...picked, all: local.list };
  });
  handle('java:install', async (evt, { major, root } = {}) => {
    try {
      const rec = await javaMgr.installJava(major, { root, onProgress: (p) => send('java:progress', p) });
      return { ok: true, java: rec };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块二：一键联机大厅（EasyTier P2P） ====================
  handle('lan:binaries', async () => {
    const b = lanRoom.defaultBinaries();
    return { ...b, verified: b.core ? await lanRoom.verifyBinary(b.core) : { ok: false, error: '未找到 easytier-core' } };
  });
  handle('lan:verify', async (evt, corePath) => lanRoom.verifyBinary(corePath));
  handle('lan:create', async (evt, opts = {}) => {
    const { room, inviteCode } = lanRoom.createRoom(opts);
    return { room, inviteCode };
  });
  handle('lan:join', async (evt, { inviteCode, ...opts } = {}) => {
    const { room, inviteCode: code } = lanRoom.joinRoom(inviteCode, opts);
    return { room, inviteCode: code };
  });
  handle('lan:start', async (evt, { room, ...opts } = {}) => getRoomManager().start(room, opts));
  handle('lan:stop', async () => getRoomManager().stop());
  handle('lan:status', async () => {
    const mgr = getRoomManager();
    if (!mgr.room) return { connected: false, running: false, virtualIp: null, peers: [], reason: '尚未启动联机' };
    return mgr.status();
  });
  handle('lan:listRooms', async () => {
    const mgr = getRoomManager();
    return mgr.listRooms();
  });

  // ==================== 模块三：本地世界（存档）智能管家 ====================
  handle('world:list', async (evt, { gameDir } = {}) =>
    worldMgr.listWorlds(gameDir || GAME_DIR));
  handle('world:inspect', async (evt, { worldDir, gameDir } = {}) =>
    worldMgr.inspectWorld(worldDir, { gameDir: gameDir || GAME_DIR }));
  handle('world:backups', async (evt, { root, world } = {}) =>
    worldMgr.listBackups(root, world));
  handle('world:backup', async (evt, { gameDir, world, root, tag, keep } = {}) =>
    worldMgr.backupWorld(gameDir || GAME_DIR, world, { root, tag, keep }));
  handle('world:restore', async (evt, { gameDir, world, zipPath, root } = {}) =>
    worldMgr.restoreWorld(gameDir || GAME_DIR, world, zipPath, { root }));

  // ==================== 模块四：3D 皮肤渲染与外观定制 ====================
  handle('skin:inspectFile', async (evt, filePath) => skinMgr.loadLocalSkin(filePath));
  handle('skin:fetchFromAuthlib', async (evt, { apiRoot, playerName } = {}) =>
    skinMgr.fetchSkinFromAuthlib(apiRoot, playerName));
  handle('skin:downloadImage', async (evt, { url } = {}) => skinMgr.downloadSkinImage(url));
  handle('skin:upload', async (evt, opts = {}) => skinMgr.uploadSkin(opts));

  // ==================== 模块一（0.4.0）：P2P 真实网络配置向导 / 容错诊断 ====================
  handle('net:guide', async () => netGuide.NETWORK_GUIDE);
  handle('net:diagnose', async (evt, payload = {}) => {
    const mgr = getRoomManager();
    const status = payload.status || await mgr.status();
    return netGuide.diagnoseHandshake({
      status,
      logs: payload.logs || status.logs,
      elapsedMs: payload.elapsedMs,
      thresholdMs: payload.thresholdMs,
      room: payload.room || mgr.room || {}
    });
  });

  // ==================== 模块二（0.4.0）：模组与资源包智能管家 ====================
  handle('mods:list', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return { ok: true, gameDir, ...modsMgr.listMods(gameDir) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('mods:conflicts', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      const listed = modsMgr.listMods(gameDir);
      return {
        ok: true, gameDir,
        ...modsMgr.detectConflicts(listed.mods, { includeDisabled: !!o.includeDisabled })
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('mods:toggle', async (evt, o = {}) => {
    try { return modsMgr.toggleMod(resolveGameDir(o), o.file, o.enabled); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('mods:packs', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return { ok: true, gameDir, ...modsMgr.listPacks(gameDir) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('mods:shaderCheck', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return {
        ok: true,
        ...modsMgr.checkShaderRequirements(modsMgr.listMods(gameDir), modsMgr.listPacks(gameDir))
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('mods:pickPack', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择光影包 / 材质包（.zip）',
      filters: [{ name: '资源包', extensions: ['zip'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('mods:import', async (evt, o = {}) => {
    try {
      return modsMgr.importPack(resolveGameDir(o), o.kind, o.srcPath, { overwrite: !!o.overwrite });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块一（0.5.0）：UI 视觉革命 — 动态背景 / 极客 JVM 面板 ====================
  // 本地背景图片：选文件 → 真实字节校验 → 返回 dataUrl（不落盘、不暴露 file:// 路径）
  handle('appearance:pickImage', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: '已取消' };
    try {
      const buf = fs.readFileSync(r.filePaths[0]);
      const info = appearance.inspectBackgroundImage(buf);
      if (!info.ok) return { ok: false, error: info.error };
      return { ok: true, ...info, sourceName: path.basename(r.filePaths[0]) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // 校验 / 归一化外观配置（渲染进程保存前调用一次，避免脏配置）
  handle('appearance:validate', async (evt, cfg) => appearance.validateAppearance(cfg));
  // 推荐 JVM 预设列表 + 参数预校验（供设置页「推荐配置」与实时校验）
  handle('jvm:profiles', async () => appearance.recommendedProfiles());
  handle('jvm:preview', async (evt, o = {}) => appearance.mergeLaunchJvm(o));

  // ============ 0.6.0 模块三：性能小雷达 / 极客一键调优 ============
  handle('jvm:monitorStatus', async () => jvmMonitor
    ? jvmMonitor.summary()
    : { running: false, samples: [], sampleCount: 0, gc: { count: 0, totalPauseMs: 0, maxPauseMs: 0, last: null } });
  handle('jvm:recommend', async () => jvmMonitorMod.recommendJvm(os.totalmem()));

  // ============ 0.6.0 模块四：Modrinth 在线资源中心 ============
  handle('modrinth:search', async (evt, q = {}) => modrinth.searchProjects(q));
  handle('modrinth:versions', async (evt, q = {}) => modrinth.fetchVersions(q));
  handle('modrinth:install', async (evt, o = {}) => {
    const gameDir = resolveGameDir(o);
    return modrinth.installProject({
      ...o,
      gameDir,
      q: { mcVersion: o.mcVersion, loader: o.loader },
      onProgress: (p) => send('modrinth:progress', p)
    });
  });

  // ============ 0.6.0 模块五：自动更新（latest.yml + 后台静默下载） ============
  handle('update:check', async (evt, o = {}) => updater.checkForUpdate({
    currentVersion: require('../package.json').version,
    ...(o || {})
  }));
  handle('update:status', async () => ({ downloading: updateState.downloading, last: updateState.last }));
  handle('update:download', async (evt, o = {}) => {
    if (updateState.downloading) return { ok: false, error: '已有更新包在后台下载中' };
    const url = o.url || o.mirrorUrl;
    if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: '缺少合法的更新包下载地址' };
    let filename;
    try { filename = path.basename(new URL(url).pathname); }
    catch { return { ok: false, error: '下载地址无法解析文件名' }; }
    const dest = path.join(os.tmpdir(), `MC-Next-update-${filename}`);
    updateState.downloading = true;
    updateState.last = null;
    // 后台执行：IPC 立即返回，进度通过 update:progress 事件推送（静默下载，不打断用户）
    (async () => {
      try {
        send('update:progress', { phase: 'start', dest, name: filename });
        await downloadFile(url, dest, {
          preferMirror: false,
          timeoutMs: 120000,
          onProgress: (received, total) => send('update:progress', { phase: 'progress', received, total, name: filename })
        });
        const verify = o.sha512
          ? updater.verifySha512(dest, o.sha512)
          : { ok: false, error: 'latest.yml 未提供 sha512，拒绝标记为可安装' };
        updateState.last = { ok: verify.ok, path: dest, verify };
        send('update:progress', { phase: verify.ok ? 'done' : 'verify-failed', path: dest, name: filename, verify });
      } catch (e) {
        updateState.last = { ok: false, error: e.message };
        send('update:progress', { phase: 'error', error: e.message, name: filename });
      } finally { updateState.downloading = false; }
    })();
    return { ok: true, started: true, dest };
  });
}

module.exports = {
  registerIpc, state, launchGameCore, logBuf, pushLog, send,
  dispatchChannel, hasChannel, HANDLERS
};
