/**
 * electron/ipc.cjs — IPC 处理器注册（main.cjs 与测试共用）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises; // 0.9.0 模块二A：主进程启动路径一律走异步 IO，不阻塞事件循环
const { ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const { lazy } = require('./lazy.cjs'); // 0.9.0 模块二A：非核心功能服务惰性加载

// —— 启动关键路径 / 核心引擎（顶层立即加载；均为轻量纯 JS，剖析合计 ~10ms）——
// 这些模块参与启动、崩溃守护、下载链路或顶层单例，必须在首帧前就绪。
const { GameLauncher, classifyLine, stripAnsi } = require('../engine/launcher');
const { deployServer, detectJarKind } = require('../engine/serverDeploy');
const { downloadFile, fetchJson } = require('../engine/http');
const { OFFICIAL, SOURCE_POLICY } = require('../engine/sources');
const { buildClasspath } = require('../engine/library');
const isolation = require('../engine/isolation.cjs');
const { downloadBatch } = require('../engine/downloader.cjs');
const { highlight, parseLogLine } = require('../engine/server/console.cjs');
const { DeviceFlowManager } = require('../engine/auth/deviceFlow.cjs'); // 顶层单例：后台设备码轮询
const preflight = require('../engine/preflight.cjs');
const crashGuardian = require('../engine/crash/guardian.cjs');
const crashReaper = require('../engine/crash/reaper.cjs');
const ipcGuard = require('../engine/crash/ipcGuard.cjs');
const speedtest = require('../engine/net/speedtest.cjs');
const parallelDownload = require('../engine/net/parallelDownload.cjs');
const releaseCfg = require('../config/release.json');

// —— 非核心功能服务（0.9.0 模块二A 惰性加载）——
// 这些服务在启动首帧前不会被访问，用 lazy 代理把 require 推迟到首次真实 IPC 调用；
// 调用点保持 `X.method()` 形态不变（Proxy get 拦截），测试 stub 注入照常命中。
// 真实剖析见 DELIVERY-0.9.0.md：收益是「启动期不解析/不常驻」，不虚报毫秒数。
const msAuth = lazy(() => require('../engine/auth/microsoft.cjs'));
const authlib = lazy(() => require('../engine/auth/authlib.cjs'));
const modpack = lazy(() => require('../engine/modpack.cjs'));
const localJar = lazy(() => require('../engine/localJar.cjs'));
const crashAnalyzer = lazy(() => require('../engine/crash/analyzer.cjs'));
const logCleaner = lazy(() => require('../engine/crash/logCleaner.cjs'));
const javaMgr = lazy(() => require('../engine/java/manager.cjs'));
const lanRoom = lazy(() => require('../engine/net/room.cjs'));
const worldMgr = lazy(() => require('../engine/world/manager.cjs'));
const skinMgr = lazy(() => require('../engine/skin/manager.cjs'));
const modsMgr = lazy(() => require('../engine/mods/manager.cjs'));
const netGuide = lazy(() => require('../engine/net/guide.cjs'));
const appearance = lazy(() => require('../engine/appearance.cjs'));
const modpackExport = lazy(() => require('../engine/modpackExport.cjs'));
const jvmMonitorMod = lazy(() => require('../engine/jvm/monitor.cjs'));
const modrinth = lazy(() => require('../engine/modrinth/client.cjs'));
const updater = lazy(() => require('../engine/updater.cjs'));

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

/** 0.7.0 模块四：全局进程登记（供主进程退出时兜底回收，杜绝僵尸 Java / Launcher 进程） */
const processRegistry = new crashReaper.ProcessRegistry();
function reapAllProcesses() {
  return crashReaper.reapAll(processRegistry);
}

/**
 * 0.6.0 模块一：统一 IPC handler 注册表。
 * 桌面端照常 ipcMain.handle；Android 大一统 UI 的 remote 指令通过
 * /api/rpc → dispatchChannel() 复用**同一个真实 handler**，不重写、不伪造。
 * 只有 registerIpc 执行过（即 Electron 主进程已启动）后表中才有条目。
 */
const HANDLERS = new Map();
function handle(channel, fn) {
  // 0.9.0 模块一C：每个 IPC handler 统一套全局异常防线。
  //  - 成功结果原样透传（零侵入，dispatchChannel / ipcMain.handle / /api/rpc 全覆盖）
  //  - 抛错归一化为 { ok:false, error, ... }，绝不 rethrow，前端不会闪退或卡在「启动中」
  //  - 命中 SIGSEGV / hs_err / UnsatisfiedLinkError 等原生层致命特征时，
  //    额外 send('game:crash')，由 CrashDialog 弹人类可读提示（而不是启动器闪退）
  const guarded = ipcGuard.wrapHandler(channel, fn, {
    onFatal: (report) => send('game:crash', report)
  });
  HANDLERS.set(channel, guarded);
  return ipcMain.handle(channel, guarded);
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
    if (!path.isAbsolute(opt.gameDir)) throw new Error('gameDir 必须是绝对路径');
    return path.resolve(opt.gameDir);
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
    // 0.9.0 模块一A：多实例完全隔离。gameDir 由显式 gameDir / instanceId / 当前激活实例
    // 三级解析，命中实例时 ensureInstance 保证 mods/saves/config 物理目录真实存在，
    // JVM 的 --gameDir 指向该实例，Forge/Fabric/Quilt 从实例目录读取 mods/config/saves。
    const dirSel = isolation.gameDirForLaunch(LAUNCHER_DIR, opts, GAME_DIR);
    // 0.7.0 模块二：Java 自动分配与版本校验统一交给 preflight（含缓存，避免每次全盘扫描）
    const nativesDir = path.join(LAUNCHER_DIR, 'natives', opts.versionId);
    const gameJar = path.join(REPO_CLIENT, `${opts.versionId}.jar`);
    const env = {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux',
      arch: process.arch === 'ia32' ? 'x86' : process.arch,
      features: {}
    };

    // 极客 JVM 面板（0.5.0）：纯计算，提前到最前，供体检读取真实生效的内存值
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

    // 0.7.0 模块二：启动前环境体检（Java 版本 / 内存防崩 / natives 中文空格路径）。
    // 刻意排在补齐依赖之前：环境有问题时零网络请求、瞬间失败，不白等下载。
    // 不新增 UI：拦截结果经既有 game:launch 返回值呈现到首页「启动失败」提示。
    const pf = preflight.runPreflight({
      mcVersion: opts.versionId,
      javaPath: opts.javaPath || null,
      minMemory: jvm.minMemory,
      maxMemory: jvm.maxMemory,
      nativesDir
    });
    for (const w of pf.warnings) {
      send('game:log', { level: 'warn', text: `[MC-Next] ${w.message}${w.fix ? ` → ${w.fix}` : ''}` });
    }
    if (!pf.ok) {
      for (const b of pf.blocking) {
        send('game:log', { level: 'error', text: `[MC-Next] ${b.message} → ${b.fix}` });
      }
      return {
        ok: false,
        error: pf.summary,
        issues: pf.issues,
        preflight: { java: pf.java, memory: pf.memory, natives: pf.natives }
      };
    }
    if (pf.resolvedJavaPath) opts.javaPath = pf.resolvedJavaPath;

    const cp = buildClasspath(vj, { repoRoot: LIBRARIES_DIR, env, gameJarPath: gameJar, extraJars: opts.extraJars || [] });

    // 自动补全缺失依赖（多源降级：官方 → BMCLAPI）
    for (const m of cp.missing) {
      if (!m.url) continue;
      send('game:log', { level: 'info', text: `[MC-Next] 补全依赖 ${m.path}` });
      await downloadFile(m.url, m.local, { expectedSha1: m.sha1 });
    }

    // 0.6.0 模块三：自动注入真实 GC 日志参数（用户已自行配置 GC 日志时不覆盖）
    const extraJvmArgs = jvm.jvmArgs.slice();
    const hasGcLogging = extraJvmArgs.some(a => /^-Xlog|gc/i.test(a));
    if (!hasGcLogging) extraJvmArgs.push(...jvmMonitorMod.gcArgsForMcVersion(opts.versionId));
    if (extraJvmArgs.length > jvm.jvmArgs.length) {
      send('game:log', { level: 'info', text: `[MC-Next] 已启用 GC 日志：${extraJvmArgs.slice(jvm.jvmArgs.length).join(' ')}` });
    }

    if (dirSel.isolated) {
      send('game:log', { level: 'info', text: `[MC-Next] 隔离实例 ${dirSel.instanceId} → ${dirSel.gameDir}` });
    }

    const launcher = new GameLauncher({
      versionJson: vj,
      classpath: cp.classpath.join(process.platform === 'win32' ? ';' : ':'),
      nativesDir,
      gameDir: dirSel.gameDir,
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
    // 0.7.0 模块四：崩溃守护 + 进程树登记。
    // 守护器只报「人类能看懂」的致命报告；接管进程由下方 fatal 回调执行。
    const guardian = new crashGuardian.CrashGuardian();
    launcher._guardian = guardian; // 绑定生命周期，供 game:stop 标记主动停止
    guardian.on('fatal', (report) => {
      send('game:crash', report);
      // 主动接管：致命错误出现后不等游戏自己退出，直接终止整棵进程树，
      // 避免卡在「启动中」或留下失控的 Java 进程。kill() 内部标记 intentional，不重复弹窗。
      if (state.game && state.game.running) {
        send('game:log', { level: 'error', text: `[MC-Next] 检测到致命错误，已主动接管并终止进程：${report.title}` });
        state.game.kill().catch(() => {});
      }
    });
    launcher.on('log', l => send('game:log', l));
    const detachGuardian = guardian.attach(launcher);

    launcher.on('exit', r => {
      // 兜底：即使流式阶段没命中，异常退出也必须给前端报告（finish 内部去重/判正常退出）。
      guardian.finish(r);
      detachGuardian();
      state.game = null;
      if (jvmMonitor) { jvmMonitor.stop(); jvmMonitor = null; }
      // 僵尸进程清理：主进程已退出，回收可能残留的 Java 子进程（进程组）。
      if (launcher.process && launcher.process.pid) {
        crashReaper.killTree({ child: launcher.process, pid: launcher.process.pid, signal: 'SIGKILL', force: true });
        processRegistry.untrack(launcher.process.pid);
      }
      send('game:exit', r);
    });
    launcher.on('error', e => send('game:log', { level: 'error', text: String(e) }));
    state.game = launcher;
    launcher.launch();
    if (launcher.process && launcher.process.pid) {
      processRegistry.track(launcher.process.pid, 'java', { versionId: opts.versionId });
    }

    // 0.6.0 模块三：挂载 JVM 监控。GameLauncher 已把 stdout/stderr 汇成 log 事件，
    // 监控器逐行解析 GC 日志，并按 1s 采样 /proc/<pid>/status 的 VmRSS 推给性能小雷达。
    if (jvmMonitor) jvmMonitor.stop();
    jvmMonitor = new jvmMonitorMod.JvmMonitor({ pid: launcher.process && launcher.process.pid });
    jvmMonitor.on('sample', (s) => send('jvm:metrics', s));
    jvmMonitor.attach(launcher);

    return {
      ok: true, missingCount: cp.missing.length, monitorPid: jvmMonitor.pid,
      instanceId: dirSel.instanceId, gameDir: dirSel.gameDir, isolated: dirSel.isolated
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerIpc(mainWindow) {
  state.mainWindow = mainWindow;

  // ---------- 本地仓库 ----------
  handle('repo:listClients', async () => {
    try {
      return (await fsp.readdir(REPO_CLIENT)).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  handle('repo:listServers', async () => {
    try {
      return (await fsp.readdir(REPO_SERVER)).filter(f => f.endsWith('.jar')).sort().reverse();
    } catch { return []; }
  });

  handle('repo:listLoaderFiles', async (evt, mcVersion) => {
    const dir = path.join('/workspace/模组加载器', mcVersion);
    try { return await fsp.readdir(dir); } catch { return []; }
  });

  // ---------- 版本清单 ----------
  handle('manifest:fetch', async () => {
    return fetchJson(OFFICIAL.versionManifest, { timeoutMs: 30000 });
  });

  handle('version:getJson', async (evt, versionId) => {
    const cache = path.join(LAUNCHER_DIR, 'versions', `${versionId}.json`);
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    // 缓存命中直接返回；缺失或损坏（read/parse 抛错）则回落网络，语义比 existsSync 更健壮
    try { return JSON.parse(await fsp.readFile(cache, 'utf8')); } catch { /* 走网络重新拉取 */ }
    const j = await fetchJson(`https://bmclapi2.bangbang93.com/version/${versionId}/json`, { timeoutMs: 30000 });
    await fsp.writeFile(cache, JSON.stringify(j));
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

  // ===== 0.9.0 模块一B：节点智能测速 + 多线程并发下载 / 断点续传 =====
  // 测速：真实并发探测官方 / BMCLAPI 延迟，返回排序结果；无公网时如实报错，不伪造延迟。
  handle('download:benchmark', async (evt, o = {}) => {
    const urls = o.urls && o.urls.length ? o.urls : speedtest.nodeCandidates(o.url || '', o.extraUrls);
    const r = await speedtest.rankNodes(urls, { timeoutMs: o.timeoutMs || 4000 });
    return {
      ok: r.ok, results: r.results, winner: r.winner ? { url: r.winner.url, id: r.winner.id, name: r.winner.name, latencyMs: r.winner.latencyMs } : null,
      cached: r.cached, error: r.error || null,
      note: r.ok ? '真实并发探测延迟，按最快节点排序' : '所有节点不可用（沙盒可能无公网），不伪造延迟'
    };
  });

  // 智能下载：测速选最快 → 并发分块（含断点续传 + 整体 sha1）→ 不支持/失败时回退既有单连接多源降级。
  handle('download:smart', async (evt, o = {}) => {
    const { id, url, dest, sha1 } = o;
    if (!url || !dest) return { ok: false, error: '缺少 url 或 dest' };
    let bench = null;
    let chosenUrl = url;
    if (o.benchmark !== false) {
      try {
        bench = await speedtest.pickFastestNode(url, { timeoutMs: o.timeoutMs || 4000 });
        if (bench.benchmarked && bench.chosenUrl) chosenUrl = bench.chosenUrl;
      } catch { /* 测速失败不阻断下载，回落原 URL */ }
    }
    // 优先并发分块（大文件显著提速）
    if (o.parallel !== false) {
      const p = await parallelDownload.downloadParallel(chosenUrl, dest, {
        expectedSha1: sha1, concurrency: o.concurrency || 4,
        onProgress: undefined
      });
      if (p.ok) {
        send('download:done', { id, sha1: p.sha1, size: p.size, mode: 'parallel', chunks: p.chunks });
        return { ok: true, ...p, mode: 'parallel', usedUrl: chosenUrl, benchmarked: !!(bench && bench.benchmarked) };
      }
      // fallback（不支持 Range / 小文件）或分块失败 → 回退既有真实单连接多源降级链
      if (!p.fallback) {
        send('download:retry', { id, url, switched: true, attempt: 0, maxAttempts: 1, delayMs: 0, error: `并发下载回退: ${p.error}` });
      }
    }
    try {
      const r = await downloadFile(chosenUrl, dest, {
        expectedSha1: sha1, preferMirror: true,
        onRetry: (info) => send('download:retry', { id, ...info }),
        onProgress: (received, total) => send('download:progress', { id, received, total })
      });
      send('download:done', { id, sha1: r.sha1, size: r.size, mode: 'single' });
      return { ok: true, ...r, mode: 'single', usedUrl: chosenUrl, benchmarked: !!(bench && bench.benchmarked) };
    } catch (e) {
      send('download:error', { id, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  // ---------- 游戏启动 ----------
  handle('game:launch', async (evt, opts) => launchGameCore(opts));

  handle('game:stop', async () => {
    if (state.game) {
      // 用户主动停止：先标记守护器，避免 TERM 退出被误判成崩溃弹窗。
      if (state.game._guardian) state.game._guardian.markIntentional();
      await state.game.kill(); state.game = null; return { ok: true };
    }
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
  handle('instance:remove', async (evt, id) => {
    const r = isolation.removeInstance(LAUNCHER_DIR, id);
    // 若删除的是当前激活实例，清掉激活态并广播，避免 UI 停留在一个不存在的实例
    if (r && isolation.getActiveInstance(LAUNCHER_DIR) === id) {
      try { await fsp.rm(path.join(LAUNCHER_DIR, isolation.ACTIVE_FILE), { force: true }); } catch {}
      send('instance:changed', { activeId: null, removed: true });
    }
    return r;
  });
  // ===== 0.9.0 模块一A：激活实例 / 一键切换 / 隔离自检 =====
  handle('instance:active', async () => isolation.getActiveInstance(LAUNCHER_DIR));
  handle('instance:switch', async (evt, id) => {
    const r = isolation.switchInstance(LAUNCHER_DIR, id);
    if (r.ok) send('instance:changed', { activeId: r.to, from: r.from });
    return r;
  });
  handle('instance:verify', async (evt, { idA, idB } = {}) =>
    isolation.verifyIsolation(LAUNCHER_DIR, idA, idB));

  // ============ 0.6.0 模块二：微软正版 OAuth2 设备码真流程 + Authlib-Injector ============
  const ms = authFlow.authenticator;   // 复用同一账号仓库（launchArgs / remove / ensureValid）
  const authlibFile = path.join(LAUNCHER_DIR, 'accounts-authlib.json');
  const readAuthlib = async () => {
    try { return JSON.parse(await fsp.readFile(authlibFile, 'utf8')); } catch { return []; }
  };
  const writeAuthlib = async (list) => {
    await fsp.mkdir(LAUNCHER_DIR, { recursive: true });
    await fsp.writeFile(authlibFile, JSON.stringify(list, null, 2), { mode: 0o600 });
  };

  handle('auth:list', async () => {
    // 只回传展示所需字段，令牌永不出主进程
    const microsoft = authFlow.list();
    const third = (await readAuthlib()).map(a => ({ ...a, type: 'authlib', hasRefresh: false }));
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
    const list = (await readAuthlib()).filter(a => !(a.uuid === account.uuid && a.apiRoot === apiRoot));
    list.push(account);
    await writeAuthlib(list);
    return { uuid: account.uuid, name: account.name, type: 'authlib', apiRoot };
  });

  handle('auth:authlibMeta', async (evt, apiRoot) => authlib.fetchMetadata(apiRoot));
  handle('auth:remove', async (evt, uuid) => {
    ms.deleteAccount(uuid);
    await writeAuthlib((await readAuthlib()).filter(a => a.uuid !== uuid));
    return { ok: true };
  });
  handle('auth:launchArgs', async (evt, uuid) => {
    const a = ms.listAccounts().find(x => x.uuid === uuid);
    if (a) return msAuth.toLaunchArgs(await ms.ensureValid(a));
    const b = (await readAuthlib()).find(x => x.uuid === uuid);
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
    try {
      const text = await fsp.readFile(p, 'utf8');
      return { ok: true, path: p, text };
    } catch { return { ok: false, error: `未找到 ${p}` }; }
  });

  // ==================== 移动端启动配置导出（供原生 APK 的 launch.json） ====================
  handle('mobile:export', async (evt, cfg) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled) return { ok: false, error: '已取消' };
    const dest = path.join(r.filePaths[0], 'launch.json');
    await fsp.writeFile(dest, JSON.stringify(cfg, null, 2));
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
      const buf = await fsp.readFile(r.filePaths[0]);
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
  dispatchChannel, hasChannel, HANDLERS,
  reapAllProcesses   // 0.7.0 模块四：主进程退出前兜底回收所有子进程
};
