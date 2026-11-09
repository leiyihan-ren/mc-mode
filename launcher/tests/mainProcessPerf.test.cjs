'use strict';
/**
 * mainProcessPerf.test.cjs — 0.9.0 模块二A：Electron 主进程减负 TDD
 *
 * 覆盖四层：
 *  1) 静态守卫：主进程三文件零同步磁盘 IO、统一 fsp、惰性加载与首帧后启动接线
 *  2) 单元：lazy 代理（惰性/缓存/身份/探测不加载）、bootMetrics（分档/预算/时钟/日志）
 *  3) E2E：stubbed electron 下 handler 执行期动态 hook fs.*Sync 证明零同步阻塞；
 *          注册期间非核心服务零加载、首次 IPC 才 require
 *  4) 真实剖析：顶层 require ipc.cjs 耗时在预算内（防「重模块搬回顶层」回退）
 *
 * 【诚实边界】Node CJS 模块加载器自身在 require 期间会用 realpathSync/readFileSync
 * 读取 .js 源文件（getMaybeCachedSource），这是运行时固有、非我们代码，
 * 因此动态 hook 断言只覆盖「handler 执行期」；顶层加载由静态守卫覆盖。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'electron');
const read = (rel) => fs.readFileSync(path.join(ELECTRON, rel), 'utf8');

/** 剥离块注释与行注释（保留 https:// 中的 //），避免注释里的字样误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

const SYNC_IO_RE = /\bfs\.(readFileSync|writeFileSync|existsSync|statSync|readdirSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|realpathSync|accessSync|appendFileSync|lstatSync|readlinkSync)\s*\(/;

/** stubbed electron（与项目其它集成测试同构） */
function fakeElectron() {
  return {
    ipcMain: { handle() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal: async () => {} }
  };
}
function withStubbedElectron(fn) {
  const orig = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron();
    return orig.apply(this, arguments);
  };
  return Promise.resolve().then(fn).finally(() => { Module._load = orig; });
}
function clearModuleCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/electron/') || k.includes('/engine/')) delete require.cache[k];
  }
}

// ==================== 1. 静态守卫 ====================

test('主进程三文件零同步磁盘 IO（排除注释/说明文字）', () => {
  for (const f of ['main.cjs', 'ipc.cjs', 'remoteControl.cjs']) {
    const code = stripComments(read(f));
    assert.doesNotMatch(code, SYNC_IO_RE, `${f} 仍存在同步磁盘 IO 调用`);
  }
});

test('主进程三文件统一使用 fs.promises (fsp) 且存在 await fsp.* 调用', () => {
  for (const f of ['main.cjs', 'ipc.cjs', 'remoteControl.cjs']) {
    const code = stripComments(read(f));
    assert.match(code, /const\s+fsp\s*=\s*fs\.promises/, `${f} 应引入 fsp`);
    assert.match(code, /await\s+fsp\.\w+\(/, `${f} 应有 await fsp.* 异步调用`);
  }
});

test('ipc.cjs 用 lazy 代理惰性加载非核心功能服务，核心模块仍顶层加载', () => {
  const ipc = read('ipc.cjs');
  assert.match(ipc, /require\('\.\/lazy\.cjs'\)/, '应引入 lazy.cjs');
  const n = (ipc.match(/=\s*lazy\(\(\)\s*=>\s*require\(/g) || []).length;
  assert.ok(n >= 15, `惰性代理模块数应 >= 15，实际 ${n}`);
  // 启动核心 / 顶层单例 / 守护链路必须立即加载
  for (const core of [
    "require('../engine/launcher')",
    "require('../engine/preflight.cjs')",
    "require('../engine/isolation.cjs')",
    "require('../engine/crash/guardian.cjs')",
    "require('../engine/auth/deviceFlow.cjs')"
  ]) {
    assert.ok(ipc.includes(core), `核心模块应顶层立即加载: ${core}`);
  }
  // 非核心服务不得再以 `const X = require(...)` 顶层加载
  for (const m of [
    '../engine/modrinth/client.cjs', '../engine/skin/manager.cjs',
    '../engine/world/manager.cjs', '../engine/net/room.cjs',
    '../engine/appearance.cjs', '../engine/updater.cjs',
    '../engine/modpack.cjs', '../engine/crash/logCleaner.cjs'
  ]) {
    const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(ipc, new RegExp(`const\\s+\\w+\\s*=\\s*require\\('${escaped}'\\)`), `${m} 应改为惰性加载`);
  }
});

test('main.cjs 遥控服务首帧后惰性启动 + 冷启动计时接线', () => {
  const main = read('main.cjs');
  assert.doesNotMatch(main, /^const\s+\{\s*startRemoteControl\s*\}/m, '不应在顶层 require 遥控服务');
  assert.match(main, /require\('\.\/bootMetrics\.cjs'\)/, '应接入 bootMetrics');
  assert.match(main, /createBootClock\(\)/, '应创建启动时钟');
  assert.match(main, /function\s+deferNonCoreServices\s*\(/, '应有延迟启动函数');
  assert.match(main, /ready-to-show[\s\S]{0,500}deferNonCoreServices\(\)/, '延迟启动应挂在首帧回调内');
  assert.match(main, /setImmediate\(/, '应让出事件循环 tick');
  assert.match(main, /format\(boot\.snapshot\(\)\)/, '应输出结构化冷启动日志');
  assert.match(main, /await\s+fsp\.access\(/, 'dist 探测应为异步 access');
  assert.match(main, /registerIpc\(mainWindow\)/, 'IPC 仍须首帧前注册（不可延迟）');
});

// ==================== 2. lazy 代理单元 ====================

test('lazy 代理：未访问不加载，首次访问才 require，之后命中缓存', () => {
  const { lazy, isLazy } = require('../electron/lazy.cjs');
  let calls = 0;
  class Foo {}
  const real = { greet: (x) => 'hi ' + x, VERSION: 9, Foo };
  const L = lazy(() => { calls++; return real; });
  assert.equal(isLazy(L), true);
  assert.equal(L.__loaded, false);
  assert.equal(calls, 0, '未访问任何属性前不得触发加载');
  assert.equal(typeof L.greet, 'function');
  assert.equal(calls, 1);
  assert.equal(L.__loaded, true);
  assert.equal(L.greet('mc'), 'hi mc');
  assert.equal(L.VERSION, 9);
  assert.equal(calls, 1, '后续访问命中缓存，不再 require');
  assert.equal(L.greet, L.greet, '函数身份稳定（未被 bind 包装）');
  assert.equal(L.Foo, Foo, '类引用原样保留，可 new');
  assert.ok(new L.Foo() instanceof Foo);
  assert.equal(L.missing, undefined);
  assert.equal(L.__module, real, '__module 探针返回真实模块');
});

test('lazy 代理：Promise / 序列化 / Symbol 探测不触发加载', async () => {
  const { lazy } = require('../electron/lazy.cjs');
  let calls = 0;
  const L = lazy(() => { calls++; return { a: 1 }; });
  assert.equal(L.then, undefined);
  assert.equal(L.toJSON, undefined);
  assert.equal(L[Symbol.toStringTag], undefined);
  const r = await Promise.resolve(L); // 不得被误判为 thenable
  assert.equal(r, L);
  assert.equal(calls, 0, '运行时探测不得吃掉惰性收益');
  assert.equal(L.a, 1);
  assert.equal(calls, 1);
});

test('lazy 代理：has / ownKeys / set 行为正确且可观测', () => {
  const { lazy } = require('../electron/lazy.cjs');
  const real = { a: 1, b: 2 };
  const L = lazy(() => real);
  assert.equal(L.__isLazy, true);
  assert.equal('__isLazy' in L, true);
  assert.equal('a' in L, true);   // has 会加载
  assert.equal(L.__loaded, true);
  assert.deepEqual(Object.keys(L).sort(), ['a', 'b']);
  L.c = 3;
  assert.equal(real.c, 3);
  assert.equal(L.c, 3);
});

// ==================== 3. bootMetrics 单元 ====================

test('bootMetrics: classifyBoot 分档边界（含非法值拒绝）', () => {
  const { classifyBoot, DEFAULT_BUDGET_MS } = require('../electron/bootMetrics.cjs');
  assert.equal(DEFAULT_BUDGET_MS, 2000);
  assert.equal(classifyBoot(0), 'excellent');
  assert.equal(classifyBoot(1200), 'excellent');
  assert.equal(classifyBoot(1201), 'good');
  assert.equal(classifyBoot(2000), 'good');
  assert.equal(classifyBoot(2001), 'over');
  assert.equal(classifyBoot(3000), 'over');
  assert.equal(classifyBoot(3001), 'critical');
  assert.equal(classifyBoot(-1), 'invalid');
  assert.equal(classifyBoot(NaN), 'invalid');
  assert.equal(classifyBoot('abc'), 'invalid');
  // 自定义预算
  assert.equal(classifyBoot(500, 1000), 'excellent');
  assert.equal(classifyBoot(900, 1000), 'good');
});

test('bootMetrics: isUnderBudget 严格判定，拒绝伪造数据', () => {
  const { isUnderBudget } = require('../electron/bootMetrics.cjs');
  assert.equal(isUnderBudget(0), true);
  assert.equal(isUnderBudget(1999), true);
  assert.equal(isUnderBudget(2000), true);
  assert.equal(isUnderBudget(2001), false);
  assert.equal(isUnderBudget(-1), false);
  assert.equal(isUnderBudget(NaN), false);
  assert.equal(isUnderBudget(Infinity), false);
  assert.equal(isUnderBudget('1999'), true); // 数值字符串按数值处理
});

test('bootMetrics: createBootClock 确定性时钟 + format 结构化日志', () => {
  const bm = require('../electron/bootMetrics.cjs');
  let t = 100;
  const clock = bm.createBootClock(() => t);
  clock.mark('bootstrap');
  t = 150; clock.mark('ipc-ready');
  t = 260;
  const snap = clock.snapshot({ note: 'cold' });
  assert.equal(snap.total, 160);
  assert.equal(snap.marks.length, 2);
  assert.equal(snap.marks[0].elapsed, 0);
  assert.equal(snap.marks[1].elapsed, 50);
  assert.equal(snap.grade, 'excellent');
  assert.equal(snap.note, 'cold');
  const line = bm.format(snap);
  assert.match(line, /160ms/);
  assert.match(line, /预算 2000ms/);
  assert.match(line, /bootstrap=0ms/);
  assert.match(line, /ipc-ready=50ms/);
  assert.match(line, /excellent/);
});

// ==================== 4. E2E ====================

test('E2E: handler 执行期零同步磁盘 IO（动态 hook fs.*Sync 抛错）', async () => {
  const names = [
    'readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'readdirSync',
    'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync',
    'realpathSync', 'accessSync', 'appendFileSync', 'lstatSync', 'readlinkSync'
  ];
  const orig = {};
  const hits = [];
  await withStubbedElectron(async () => {
    clearModuleCache();
    // 必须在 hook 之前完成 require：Node CJS loader 自身 require 期间会同步读 .js 源
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(null);
    for (const n of names) {
      orig[n] = fs[n];
      fs[n] = function () { hits.push(n); throw new Error('主进程路径出现同步 IO: ' + n); };
    }
    try {
      const sources = await ipc.dispatchChannel('download:sources');
      assert.ok(sources && typeof sources === 'object');
      const clients = await ipc.dispatchChannel('repo:listClients');
      assert.ok(Array.isArray(clients));
      const servers = await ipc.dispatchChannel('repo:listServers');
      assert.ok(Array.isArray(servers));
      const loaders = await ipc.dispatchChannel('repo:listLoaderFiles', '1.20.1');
      assert.ok(Array.isArray(loaders));
      assert.deepEqual(hits, [], `handler 执行期不得出现同步 IO，实际命中: ${[...new Set(hits)].join(', ')}`);
    } finally {
      for (const n of names) fs[n] = orig[n];
      clearModuleCache();
    }
  });
});

test('E2E: registerIpc 期间非核心服务零加载，首次 IPC 访问才 require', async () => {
  const watched = [
    '../engine/modrinth/client.cjs', '../engine/skin/manager.cjs',
    '../engine/world/manager.cjs', '../engine/net/room.cjs',
    '../engine/crash/logCleaner.cjs', '../engine/appearance.cjs',
    '../engine/updater.cjs', '../engine/modpack.cjs'
  ];
  const loads = [];
  const orig = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron();
    if (watched.includes(request)) loads.push(request);
    return orig.apply(this, arguments);
  };
  clearModuleCache();
  try {
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(null);
    assert.deepEqual(loads, [], '启动 + 注册期间不得加载任何非核心功能服务');
    // crash:clean 纯内存，首次调用应惰性加载 logCleaner
    const r = await ipc.dispatchChannel('crash:clean', 'hello\nworld');
    assert.ok(r && typeof r === 'object');
    assert.ok(loads.includes('../engine/crash/logCleaner.cjs'), '首次 crash:clean 应惰性加载 logCleaner');
    assert.ok(!loads.includes('../engine/modrinth/client.cjs'), '未访问的服务仍不得加载');
    assert.ok(!loads.includes('../engine/updater.cjs'), '未访问的自动更新模块仍不得加载');
  } finally {
    Module._load = orig;
    clearModuleCache();
  }
});

test('真实剖析: stubbed electron 下 ipc.cjs 顶层加载耗时 < 800ms（防重模块回退）', async () => {
  const { performance } = require('perf_hooks');
  await withStubbedElectron(() => {
    clearModuleCache();
    const t = performance.now();
    require('../electron/ipc.cjs');
    const ms = performance.now() - t;
    assert.ok(ms < 800, `顶层加载 ${ms.toFixed(1)}ms 超预算，可能把重模块搬回了顶层`);
    clearModuleCache();
  });
});

test('E2E: 主进程启动链路（stubbed Electron 生命周期）真实跑通 + 冷启动打点', async () => {
  const { EventEmitter } = require('events');
  const orig = Module._load;
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  // 确定性等待：不依赖固定 sleep（全量测试并发时 sleep 会 flaky），改为等真实事件
  let resolveWindow;
  const windowCreated = new Promise(r => { resolveWindow = r; });
  let resolveRemote;
  const remoteStarted = new Promise(r => { resolveRemote = r; });
  const withTimeout = (p, label, ms = 5000) => {
    let t;
    const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' 超时')), ms); });
    return Promise.race([p, guard]).finally(() => clearTimeout(t));
  };
  const app = new EventEmitter();
  app.whenReady = () => ready;
  let win = null;
  class FakeBrowserWindow extends EventEmitter {
    constructor(opts) {
      super(); this.opts = opts; this.loaded = null; this.shown = false;
      win = this; resolveWindow(this);
    }
    loadURL(u) { this.loaded = { type: 'url', value: u }; }
    loadFile(p) { this.loaded = { type: 'file', value: p }; }
    show() { this.shown = true; }
  }
  let remoteCount = 0;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        app, BrowserWindow: FakeBrowserWindow,
        ipcMain: { handle() {} },
        dialog: { showOpenDialog: async () => ({ canceled: true }) },
        shell: { openExternal: async () => {} }
      };
    }
    // 拦截非核心后台服务，避免测试真的 listen 25300 端口
    if (request === './remoteControl.cjs') {
      return { startRemoteControl: () => { remoteCount++; resolveRemote(); return {}; } };
    }
    return orig.apply(this, arguments);
  };
  const stdoutOrig = process.stdout.write;
  const bootLogs = [];
  process.stdout.write = function (s) {
    const str = String(s);
    if (str.includes('[MC-Next][boot]')) bootLogs.push(str);
    return stdoutOrig.call(process.stdout, s);
  };
  clearModuleCache();
  try {
    require('../electron/main.cjs');
    assert.ok(app.listenerCount('before-quit') > 0, '应注册退出清理钩子');
    assert.ok(app.listenerCount('window-all-closed') > 0, '应注册窗口关闭钩子');

    readyResolve();
    // detectLoadTarget 内有一次真实异步 fsp.access：等窗口创建事件，不靠猜时间
    await withTimeout(windowCreated, '窗口创建');
    assert.ok(win, 'app ready 后应创建主窗口');
    assert.ok(win.loaded && ['url', 'file'].includes(win.loaded.type), '应加载首帧目标');
    assert.equal(remoteCount, 0, '首帧前不得启动遥控服务');

    win.emit('ready-to-show');
    assert.equal(win.shown, true, '首帧应调用 show()');
    assert.ok(bootLogs.length >= 1, '应输出结构化冷启动日志（含各阶段耗时）');
    assert.match(bootLogs[0], /bootstrap=.*modules-loaded=/, '日志应含启动阶段打点');

    // 首帧后 setImmediate 拉起遥控服务：等启动事件而非固定 sleep
    await withTimeout(remoteStarted, '遥控服务延迟启动');
    assert.equal(remoteCount, 1, '遥控服务应在首帧后延迟启动恰好一次');
  } finally {
    process.stdout.write = stdoutOrig;
    Module._load = orig;
    clearModuleCache();
  }
});
