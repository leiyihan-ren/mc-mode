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
const releaseCfg = require('../config/release.json');

const HOME = require('os').homedir();
const LAUNCHER_DIR = path.join(HOME, '.mc-next');
const GAME_DIR = path.join(LAUNCHER_DIR, 'game');
const LIBRARIES_DIR = path.join(LAUNCHER_DIR, 'libraries');
const ASSETS_DIR = path.join(LAUNCHER_DIR, 'assets');
const REPO_CLIENT = '/workspace/MC正式版客户端';
const REPO_SERVER = '/workspace/MC正式版服务端';

/** 运行状态（模块级单例） */
const state = { game: null, server: null, mainWindow: null };
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
      extraJvmArgs: jvm.jvmArgs,
      env
    });
    launcher.on('log', l => send('game:log', l));
    launcher.on('exit', r => { state.game = null; send('game:exit', r); });
    launcher.on('error', e => send('game:log', { level: 'error', text: String(e) }));
    state.game = launcher;
    launcher.launch();
    return { ok: true, missingCount: cp.missing.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerIpc(mainWindow) {
  state.mainWindow = mainWindow;

  // ---------- 本地仓库 ----------
  ipcMain.handle('repo:listClients', async () => {
    try {
      return fs.readdirSync(REPO_CLIENT).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  ipcMain.handle('repo:listServers', async () => {
    try {
      return fs.readdirSync(REPO_SERVER).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  ipcMain.handle('repo:listLoaderFiles', async (evt, mcVersion) => {
    const out = [];
    const dir = path.join('/workspace/模组加载器', mcVersion);
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) out.push(f);
    return out;
  });

  // ---------- 版本清单 ----------
  ipcMain.handle('manifest:fetch', async () => {
    return fetchJson(OFFICIAL.versionManifest, { timeoutMs: 30000 });
  });

  ipcMain.handle('version:getJson', async (evt, versionId) => {
    const cache = path.join(LAUNCHER_DIR, 'versions', `${versionId}.json`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
    const j = await fetchJson(`https://bmclapi2.bangbang93.com/version/${versionId}/json`, { timeoutMs: 30000 });
    fs.writeFileSync(cache, JSON.stringify(j));
    return j;
  });

  // ---------- 下载（0.4.0：BMCLAPI 首选 + 指数退避 + 重试事件） ----------
  ipcMain.handle('download:sources', async () => SOURCE_POLICY);
  ipcMain.handle('download:start', async (evt, { id, url, dest, sha1, size }) => {
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
  ipcMain.handle('game:launch', async (evt, opts) => launchGameCore(opts));

  ipcMain.handle('game:stop', async () => {
    if (state.game) { await state.game.kill(); state.game = null; return { ok: true }; }
    return { ok: false, error: '无运行中的游戏' };
  });

  ipcMain.handle('game:status', async () => !!(state.game && state.game.running));

  // ---------- 服务端 ----------
  ipcMain.handle('server:detect', async (evt, jarPath) => detectJarKind(jarPath));

  ipcMain.handle('server:deploy', async (evt, { jarPath, workDir, memory, javaPath }) => {
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

  ipcMain.handle('server:start', async (evt, { workDir, coreJar, memory, javaPath }) => {
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

  ipcMain.handle('server:stop', async () => {
    if (state.server) {
      state.server.kill('SIGTERM');
      state.server = null;
      return { ok: true };
    }
    return { ok: false, error: '无运行中的服务端' };
  });

  ipcMain.handle('server:command', async (evt, cmd) => {
    if (state.server && state.server.stdin && state.server.stdin.writable) {
      state.server.stdin.write(cmd + '\n');
      return { ok: true };
    }
    return { ok: false, error: '服务端未运行' };
  });

  ipcMain.handle('server:status', async () => !!(state.server && !state.server.killed));

  // ---------- 对话框 ----------
  ipcMain.handle('dialog:pickJar', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Jar 文件',
      filters: [{ name: 'Jar', extensions: ['jar'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async (evt, exts = ['mrpack', 'zip', 'json']) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择整合包 / 配置文件',
      filters: [{ name: '整合包', extensions: exts }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ==================== 模块二：极致版本隔离 ====================
  ipcMain.handle('instance:list', async () => isolation.listInstances(LAUNCHER_DIR));
  ipcMain.handle('instance:create', async (evt, o) =>
    isolation.ensureInstance(LAUNCHER_DIR, o.id, {
      name: o.name, gameVersion: o.gameVersion, loader: o.loader
    }));
  ipcMain.handle('instance:info', async (evt, id) => isolation.instanceInfo(LAUNCHER_DIR, id));
  ipcMain.handle('instance:args', async (evt, id, extras) =>
    isolation.buildInstanceArgs(LAUNCHER_DIR, id, extras || {}));
  ipcMain.handle('instance:remove', async (evt, id) => isolation.removeInstance(LAUNCHER_DIR, id));

  // ==================== 模块二：微软正版 OAuth2 + Authlib-Injector ====================
  const ms = new msAuth.MicrosoftAuthenticator({ storeFile: path.join(LAUNCHER_DIR, 'accounts.json') });
  const deviceSessions = new Map();
  const authlibFile = path.join(LAUNCHER_DIR, 'accounts-authlib.json');
  const readAuthlib = () => {
    try { return JSON.parse(fs.readFileSync(authlibFile, 'utf8')); } catch { return []; }
  };
  const writeAuthlib = (list) => {
    fs.mkdirSync(LAUNCHER_DIR, { recursive: true });
    fs.writeFileSync(authlibFile, JSON.stringify(list, null, 2), { mode: 0o600 });
  };

  ipcMain.handle('auth:list', async () => {
    const microsoft = ms.listAccounts().map(a => ({ ...a, type: 'microsoft' }));
    const third = readAuthlib().map(a => ({ ...a, type: 'authlib' }));
    return [...microsoft, ...third].map(({ msAccessToken, msRefreshToken, ...safe }) => ({
      ...safe, hasRefresh: !!msRefreshToken
    }));
  });

  ipcMain.handle('auth:deviceStart', async () => {
    const session = await ms.createDeviceCodeSession();
    const id = crypto.randomUUID();
    deviceSessions.set(id, session);
    return {
      id, userCode: session.user_code,
      verificationUri: session.verification_uri, expiresIn: session.expires_in
    };
  });

  ipcMain.handle('auth:deviceComplete', async (evt, id) => {
    const session = deviceSessions.get(id);
    if (!session) throw new Error('设备码会话不存在或已过期，请重新发起登录');
    const token = await ms.pollDeviceCode(session);
    const account = await ms.authenticateWithMsToken(token);
    ms.saveAccount(account);
    deviceSessions.delete(id);
    return { uuid: account.uuid, name: account.name, type: 'microsoft' };
  });

  ipcMain.handle('auth:authlibLogin', async (evt, { apiRoot, username, password }) => {
    const account = await authlib.authenticate(apiRoot, { username, password });
    const list = readAuthlib().filter(a => !(a.uuid === account.uuid && a.apiRoot === apiRoot));
    list.push(account);
    writeAuthlib(list);
    return { uuid: account.uuid, name: account.name, type: 'authlib', apiRoot };
  });

  ipcMain.handle('auth:authlibMeta', async (evt, apiRoot) => authlib.fetchMetadata(apiRoot));
  ipcMain.handle('auth:remove', async (evt, uuid) => {
    ms.deleteAccount(uuid);
    writeAuthlib(readAuthlib().filter(a => a.uuid !== uuid));
    return { ok: true };
  });
  ipcMain.handle('auth:launchArgs', async (evt, uuid) => {
    const a = ms.listAccounts().find(x => x.uuid === uuid);
    if (a) return msAuth.toLaunchArgs(await ms.ensureValid(a));
    const b = readAuthlib().find(x => x.uuid === uuid);
    if (b) return authlib.toLaunchArgs(b);
    throw new Error('账号不存在');
  });

  // ==================== 模块二：多源并发下载 ====================
  ipcMain.handle('download:batch', async (evt, { tasks, concurrency, preferMirror, backoffBaseMs }) => {
    return downloadBatch(tasks, {
      concurrency: concurrency || 8,
      preferMirror: preferMirror !== false,
      ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
      onEvent: (e) => send('download:batch', e)
    });
  });

  // ==================== 模块二：整合包一键安装（0.5.0 带依赖预检硬拦截） ====================
  ipcMain.handle('modpack:parse', async (evt, filePath) => modpack.parseModpack(filePath));
  // 拖拽导入：接收 base64 文件字节（避免依赖 file.path 在 WebView / Capacitor 下不可用）
  ipcMain.handle('modpack:parseBuffer', async (evt, { base64 } = {}) => {
    if (!base64 || typeof base64 !== 'string') return { ok: false, error: '拖拽文件为空' };
    try {
      const plan = modpack.parseModpack(Buffer.from(base64, 'base64'));
      return { ok: true, plan, describe: modpackExport.describeModpack(plan) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('modpack:describe', async (evt, plan) => {
    try { return { ok: true, ...modpackExport.describeModpack(plan) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('modpack:preflight', async (evt, plan) => {
    try { return { ok: true, ...modpackExport.preflightImport(plan) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('modpack:install', async (evt, { plan, instanceId, apiKey, force } = {}) => {
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
  ipcMain.handle('modpack:export', async (evt, { instanceId, name, versionId, includePacks } = {}) => {
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
  ipcMain.handle('modpack:readManifest', async (evt, filePath) => {
    try {
      const m = modpackExport.readExportManifest(filePath);
      return m ? { ok: true, manifest: m } : { ok: false, error: '该包不含 MC-Next 自描述清单' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块三：本地 Jar 智能解析与合并 ====================
  ipcMain.handle('localJar:inspect', async (evt, p) => localJar.inspectJar(p));
  ipcMain.handle('localJar:plan', async (evt, o) => localJar.buildLocalLaunchPlan({
    gameJar: o.gameJar,
    loaderJars: o.loaderJars || [],
    libraries: o.libraries || [],
    outDir: o.outDir || path.join(LAUNCHER_DIR, 'local', o.id || 'default')
  }));

  // ==================== 模块三：硬核终端日志（彩色高亮） ====================
  ipcMain.handle('console:highlight', async (evt, raw) => highlight(raw));
  ipcMain.handle('console:highlightBatch', async (evt, lines) =>
    (lines || []).map(l => highlight(String(l))));
  ipcMain.handle('console:parse', async (evt, raw) => parseLogLine(raw));

  // ==================== 模块四：崩溃分析与日志净化 ====================
  ipcMain.handle('crash:analyze', async (evt, o) => crashAnalyzer.analyzeCrash(o));
  ipcMain.handle('crash:clean', async (evt, text) => {
    const r = logCleaner.cleanLatestLog(text, { maxLines: 120 });
    return { ...r, report: logCleaner.toPlainTextReport(r) };
  });
  ipcMain.handle('crash:readLatestLog', async (evt, gameDir) => {
    const p = path.join(gameDir || GAME_DIR, 'logs', 'latest.log');
    if (!fs.existsSync(p)) return { ok: false, error: `未找到 ${p}` };
    return { ok: true, path: p, text: fs.readFileSync(p, 'utf8') };
  });

  // ==================== 移动端启动配置导出（供原生 APK 的 launch.json） ====================
  ipcMain.handle('mobile:export', async (evt, cfg) => {
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
  ipcMain.handle('app:release', async () => {
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
  ipcMain.handle('app:openExternal', async (evt, url) => {
    if (!/^https:\/\//.test(url)) return { ok: false, error: '仅允许 https 外链' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // ==================== 模块一：Java 运行环境智能管家 ====================
  ipcMain.handle('java:scan', async (evt, { extraRoots } = {}) => {
    const r = javaMgr.scanLocalJava({ extraRoots: extraRoots || [] });
    return { ok: true, ...r };
  });
  ipcMain.handle('java:required', async (evt, mcVersion) => javaMgr.requiredJava(mcVersion));
  ipcMain.handle('java:select', async (evt, { mcVersion, extraRoots }) => {
    const local = javaMgr.scanLocalJava({ extraRoots: extraRoots || [] });
    const picked = javaMgr.selectJava(local.list, mcVersion);
    return { ...picked, all: local.list };
  });
  ipcMain.handle('java:install', async (evt, { major, root } = {}) => {
    try {
      const rec = await javaMgr.installJava(major, { root, onProgress: (p) => send('java:progress', p) });
      return { ok: true, java: rec };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块二：一键联机大厅（EasyTier P2P） ====================
  ipcMain.handle('lan:binaries', async () => {
    const b = lanRoom.defaultBinaries();
    return { ...b, verified: b.core ? await lanRoom.verifyBinary(b.core) : { ok: false, error: '未找到 easytier-core' } };
  });
  ipcMain.handle('lan:verify', async (evt, corePath) => lanRoom.verifyBinary(corePath));
  ipcMain.handle('lan:create', async (evt, opts = {}) => {
    const { room, inviteCode } = lanRoom.createRoom(opts);
    return { room, inviteCode };
  });
  ipcMain.handle('lan:join', async (evt, { inviteCode, ...opts } = {}) => {
    const { room, inviteCode: code } = lanRoom.joinRoom(inviteCode, opts);
    return { room, inviteCode: code };
  });
  ipcMain.handle('lan:start', async (evt, { room, ...opts } = {}) => getRoomManager().start(room, opts));
  ipcMain.handle('lan:stop', async () => getRoomManager().stop());
  ipcMain.handle('lan:status', async () => {
    const mgr = getRoomManager();
    if (!mgr.room) return { connected: false, running: false, virtualIp: null, peers: [], reason: '尚未启动联机' };
    return mgr.status();
  });
  ipcMain.handle('lan:listRooms', async () => {
    const mgr = getRoomManager();
    return mgr.listRooms();
  });

  // ==================== 模块三：本地世界（存档）智能管家 ====================
  ipcMain.handle('world:list', async (evt, { gameDir } = {}) =>
    worldMgr.listWorlds(gameDir || GAME_DIR));
  ipcMain.handle('world:inspect', async (evt, { worldDir, gameDir } = {}) =>
    worldMgr.inspectWorld(worldDir, { gameDir: gameDir || GAME_DIR }));
  ipcMain.handle('world:backups', async (evt, { root, world } = {}) =>
    worldMgr.listBackups(root, world));
  ipcMain.handle('world:backup', async (evt, { gameDir, world, root, tag, keep } = {}) =>
    worldMgr.backupWorld(gameDir || GAME_DIR, world, { root, tag, keep }));
  ipcMain.handle('world:restore', async (evt, { gameDir, world, zipPath, root } = {}) =>
    worldMgr.restoreWorld(gameDir || GAME_DIR, world, zipPath, { root }));

  // ==================== 模块四：3D 皮肤渲染与外观定制 ====================
  ipcMain.handle('skin:inspectFile', async (evt, filePath) => skinMgr.loadLocalSkin(filePath));
  ipcMain.handle('skin:fetchFromAuthlib', async (evt, { apiRoot, playerName } = {}) =>
    skinMgr.fetchSkinFromAuthlib(apiRoot, playerName));
  ipcMain.handle('skin:downloadImage', async (evt, { url } = {}) => skinMgr.downloadSkinImage(url));
  ipcMain.handle('skin:upload', async (evt, opts = {}) => skinMgr.uploadSkin(opts));

  // ==================== 模块一（0.4.0）：P2P 真实网络配置向导 / 容错诊断 ====================
  ipcMain.handle('net:guide', async () => netGuide.NETWORK_GUIDE);
  ipcMain.handle('net:diagnose', async (evt, payload = {}) => {
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
  ipcMain.handle('mods:list', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return { ok: true, gameDir, ...modsMgr.listMods(gameDir) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mods:conflicts', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      const listed = modsMgr.listMods(gameDir);
      return {
        ok: true, gameDir,
        ...modsMgr.detectConflicts(listed.mods, { includeDisabled: !!o.includeDisabled })
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mods:toggle', async (evt, o = {}) => {
    try { return modsMgr.toggleMod(resolveGameDir(o), o.file, o.enabled); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mods:packs', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return { ok: true, gameDir, ...modsMgr.listPacks(gameDir) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mods:shaderCheck', async (evt, o = {}) => {
    try {
      const gameDir = resolveGameDir(o);
      return {
        ok: true,
        ...modsMgr.checkShaderRequirements(modsMgr.listMods(gameDir), modsMgr.listPacks(gameDir))
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('mods:pickPack', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择光影包 / 材质包（.zip）',
      filters: [{ name: '资源包', extensions: ['zip'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('mods:import', async (evt, o = {}) => {
    try {
      return modsMgr.importPack(resolveGameDir(o), o.kind, o.srcPath, { overwrite: !!o.overwrite });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ==================== 模块一（0.5.0）：UI 视觉革命 — 动态背景 / 极客 JVM 面板 ====================
  // 本地背景图片：选文件 → 真实字节校验 → 返回 dataUrl（不落盘、不暴露 file:// 路径）
  ipcMain.handle('appearance:pickImage', async () => {
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
  ipcMain.handle('appearance:validate', async (evt, cfg) => appearance.validateAppearance(cfg));
  // 推荐 JVM 预设列表 + 参数预校验（供设置页「推荐配置」与实时校验）
  ipcMain.handle('jvm:profiles', async () => appearance.recommendedProfiles());
  ipcMain.handle('jvm:preview', async (evt, o = {}) => appearance.mergeLaunchJvm(o));
}

module.exports = { registerIpc, state, launchGameCore, logBuf, pushLog, send };
