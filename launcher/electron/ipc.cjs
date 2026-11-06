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
const { OFFICIAL } = require('../engine/sources');
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

    const launcher = new GameLauncher({
      versionJson: vj,
      classpath: cp.classpath.join(process.platform === 'win32' ? ';' : ':'),
      nativesDir: path.join(LAUNCHER_DIR, 'natives', opts.versionId),
      gameDir: GAME_DIR,
      assetsDir: ASSETS_DIR,
      assetIndexId: vj.assetIndex ? vj.assetIndex.id : 'legacy',
      javaPath: opts.javaPath || 'java',
      minMemory: opts.minMemory || '1G',
      maxMemory: opts.maxMemory || '4G',
      playerName: opts.playerName || 'Player',
      uuid: opts.uuid,
      versionId: opts.versionId,
      versionType: 'MC-Next',
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

  // ---------- 下载 ----------
  ipcMain.handle('download:start', async (evt, { id, url, dest, sha1, size }) => {
    try {
      const r = await downloadFile(url, dest, {
        expectedSha1: sha1,
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
  ipcMain.handle('download:batch', async (evt, { tasks, concurrency }) => {
    return downloadBatch(tasks, {
      concurrency: concurrency || 8,
      onEvent: (e) => send('download:batch', e)
    });
  });

  // ==================== 模块二：整合包一键安装 ====================
  ipcMain.handle('modpack:parse', async (evt, filePath) => modpack.parseModpack(filePath));
  ipcMain.handle('modpack:install', async (evt, { plan, instanceId, apiKey }) => {
    return modpack.installPlan({
      plan, root: LAUNCHER_DIR, instanceId, apiKey: apiKey || process.env.MCNEXT_CURSE_API_KEY,
      onEvent: (e) => send('modpack:progress', e)
    });
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
}

module.exports = { registerIpc, state, launchGameCore, logBuf, pushLog, send };
