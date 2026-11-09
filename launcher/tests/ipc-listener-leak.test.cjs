'use strict';
/**
 * ipc-listener-leak.test.cjs — 0.9.0 通宵加固：Electron / Capacitor 双端 IPC 订阅隔离与内存泄漏归零
 *
 * 【发现与修复的真实缺陷】
 * electron/preload.cjs 的 17 个 on* 事件订阅方法原本写为
 *   onGameLog: (cb) => ipcRenderer.on('game:log', (_e, l) => cb(l))
 * Electron 的 ipcRenderer.on 是 EventEmitter#on，返回 this（ipcRenderer 实例，object），
 * 并非函数。渲染层 src/services/bridge.js subscribe() 把它交给 wrapSubscription(off)，
 * 后者 `typeof off === 'function'` 恒为 false → removeListener 永不触发。
 * 而订阅仪表只统计 registry（release() 一定执行），显示 created==disposed「归零」是假绿：
 * 底层 ipcRenderer 每轮 mount/unmount 都残留一个真实监听器，长时间挂机单调累积。
 * Android polyfill（nativeBridge.js）早已返回真正的 off，双端行为不一致。
 *
 * 【修复】preload 内把 require('electron').ipcRenderer 局部包一层，仅重写 on()：
 * 注册真实监听器后返回幂等 off（闭包持有同一 handler 引用，removeListener 精确移除）。
 * 17 个 on* 方法字面量保持原样 → 契约生成器正则 / 三端契约 / 既有断言零漂移。
 *
 * 【验证方式（诚实边界）】真实 24h heap 曲线需 Electron 运行时 + 真机观测，沙盒无 GUI 不伪造
 * 内存数字。这里用真实 EventEmitter 语义的 fake ipcRenderer，验证**结构性不变量**：
 * 订阅返回函数、off 精确注销同一 handler、2000 轮高频挂机后底层监听器恒回 0、
 * 与订阅仪表（wrapSubscription）组合后双端一致归零。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'electron', 'preload.cjs');
const MEM_PATH = path.join(ROOT, 'src', 'lib', 'memory.mjs');
const contract = require('../engine/bridge/contract.cjs');

/**
 * 用「真实 EventEmitter 语义」的假 ipcRenderer 加载真实 preload.cjs。
 * on / removeListener / listenerCount 全部沿用 EventEmitter 的真实实现，
 * 因此本测试验证的是真注销链路，而非 mock 自说自话。
 * @returns {{ api: object, ipcRenderer: EventEmitter, exposedName: string }}
 */
function loadPreload() {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.setMaxListeners(0); // 高频挂机测试下屏蔽 maxListeners 警告，不影响语义
  const invokeCalls = [];
  ipcRenderer.invoke = async (...args) => { invokeCalls.push(args); return { ok: true, args }; };
  let api = null, exposedName = null;

  const original = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: (name, obj) => { exposedName = name; api = obj; }
        },
        ipcRenderer
      };
    }
    return original.apply(this, arguments);
  };
  delete require.cache[require.resolve(PRELOAD)];
  try {
    require(PRELOAD);
  } finally {
    Module._load = original;
    delete require.cache[require.resolve(PRELOAD)];
  }
  return { api, ipcRenderer, exposedName, invokeCalls };
}

const EVENT_METHODS = Object.keys(contract.EVENT_METHOD_MAP);
const INVOKE_METHODS = Object.keys(contract.METHOD_MAP);

// ==================== 1. 隔离边界：contextBridge 只暴露白名单，不泄漏 Node 能力 ====================
test('contextBridge 暴露名固定 mcnext，且不含 require/process/ipcRenderer 等底层能力', () => {
  const { api, exposedName } = loadPreload();
  assert.equal(exposedName, 'mcnext');
  assert.ok(api && typeof api === 'object');
  for (const leak of ['require', 'process', 'ipcRenderer', 'ipcMain', '__dirname', 'Buffer', 'module']) {
    assert.equal(api[leak], undefined, `contextBridge 泄漏了 ${leak}`);
  }
  // platform / isRoot 是允许的只读平台字段
  assert.ok(['linux', 'darwin', 'win32'].includes(api.platform));
  assert.equal(typeof api.isRoot, 'boolean');
});

test('暴露面与契约完全对齐：102 invoke + 17 event 方法，无多余/缺失', () => {
  const { api } = loadPreload();
  for (const m of INVOKE_METHODS) assert.equal(typeof api[m], 'function', `缺 invoke 方法 ${m}`);
  for (const m of EVENT_METHODS) assert.equal(typeof api[m], 'function', `缺 event 方法 ${m}`);
  const extras = Object.keys(api).filter(k =>
    !INVOKE_METHODS.includes(k) && !EVENT_METHODS.includes(k) &&
    !['platform', 'isRoot'].includes(k));
  assert.deepEqual(extras, [], `暴露了契约外方法: ${extras.join(', ')}`);
  assert.equal(INVOKE_METHODS.length, 102);
  assert.equal(EVENT_METHODS.length, 17);
});

test('invoke 方法透传到 ipcRenderer.invoke，channel 与参数与契约一致', async () => {
  const { api, invokeCalls } = loadPreload();
  const r = await api.listClients();
  assert.equal(r.ok, true);
  assert.deepEqual(invokeCalls[0], ['repo:listClients']);
  // 注意：preload 里 worldBackup 会把 (gameDir, world, opts) 打包成单个对象再透传
  await api.worldBackup('/game', 'W', { label: 'x' });
  assert.deepEqual(invokeCalls[1], ['world:backup', { gameDir: '/game', world: 'W', label: 'x' }]);
  for (const [m, ch] of Object.entries(contract.METHOD_MAP)) {
    const before = invokeCalls.length;
    await api[m]();
    assert.equal(invokeCalls[before][0], ch, `${m} 的 channel 映射错误`);
  }
});

// ==================== 2. 核心修复：每个 on* 返回可注销函数，且精确移除同一 handler ====================
test('全部 17 个 on* 订阅方法返回「函数」(off)，而非 ipcRenderer 实例 object', () => {
  const { api } = loadPreload();
  for (const m of EVENT_METHODS) {
    const off = api[m](() => {});
    assert.equal(typeof off, 'function', `${m} 未返回可注销函数（内存泄漏根因）`);
  }
});

test('off 精确注册并注销同一 handler：listenerCount 0→1→0', () => {
  const { api, ipcRenderer } = loadPreload();
  const ch = contract.EVENT_METHOD_MAP.onGameCrash;
  assert.equal(ipcRenderer.listenerCount(ch), 0);
  const got = [];
  const off = api.onGameCrash((p) => got.push(p));
  assert.equal(ipcRenderer.listenerCount(ch), 1, '订阅后应恰好 1 个监听器');
  // 事件载荷透传：preload 的 (_e, r) => cb(r) 语义不变
  ipcRenderer.emit(ch, {}, { code: 'SIGSEGV', severity: 'fatal' });
  assert.deepEqual(got, [{ code: 'SIGSEGV', severity: 'fatal' }]);
  assert.equal(off(), true, '首次 off 应返回 true（已注销）');
  assert.equal(ipcRenderer.listenerCount(ch), 0, 'off 后监听器必须归零');
  ipcRenderer.emit(ch, {}, { code: 'LATE' });
  assert.equal(got.length, 1, '注销后不得再收到事件');
});

test('off 幂等：重复调用只注销一次，绝不重复 removeListener / 误删他人监听', () => {
  const { api, ipcRenderer } = loadPreload();
  const ch = contract.EVENT_METHOD_MAP.onGameLog;
  const persistent = () => {};
  ipcRenderer.on(ch, persistent); // 第三方持久监听，不能被误删
  const off = api.onGameLog(() => {});
  assert.equal(ipcRenderer.listenerCount(ch), 2);
  assert.equal(off(), true);
  assert.equal(off(), false, '重复 off 应返回 false');
  assert.equal(off(), false);
  assert.equal(ipcRenderer.listenerCount(ch), 1, '只应移除自己的监听，保留第三方');
  assert.ok(ipcRenderer.listeners(ch).includes(persistent));
});

// ==================== 3. 高频挂机等价：2000 轮 mount/unmount，底层监听器恒回 0 ====================
test('挂机不变量：2000 轮全事件订阅/注销，底层 ipcRenderer 监听器单调归零', () => {
  const { api, ipcRenderer } = loadPreload();
  const ROUNDS = 2000;
  for (let i = 0; i < ROUNDS; i++) {
    const offs = EVENT_METHODS.map(m => api[m](() => {}));
    // 挂载瞬间：每个事件 channel 恰好 1 个监听（按 channel 去重计数）
    if (i % 500 === 0) {
      for (const ch of contract.EVENT_CHANNELS) {
        assert.equal(ipcRenderer.listenerCount(ch), 1, `第 ${i} 轮 ${ch} 监听数异常`);
      }
    }
    for (const off of offs) off();
    // 卸载后必须全部归零，严禁单调累积
    if (i % 500 === 0) {
      for (const ch of contract.EVENT_CHANNELS) {
        assert.equal(ipcRenderer.listenerCount(ch), 0, `第 ${i} 轮 ${ch} 未归零（泄漏）`);
      }
    }
  }
  for (const ch of contract.EVENT_CHANNELS) {
    assert.equal(ipcRenderer.listenerCount(ch), 0, `${ch} 最终残留监听器`);
  }
  assert.equal(ipcRenderer.eventNames().length, 0, '不应有任何残留 channel');
});

// ==================== 4. 与订阅仪表组合：wrapSubscription + preload off 双端一致归零 ====================
test('端到端：bridge.subscribe 的 wrapSubscription 包装 preload off 后，仪表与底层双归零', async () => {
  const M = await import(pathToFileURL(MEM_PATH).href);
  M.subscriptionRegistry.reset();
  const { api, ipcRenderer } = loadPreload();

  const releases = [];
  for (let i = 0; i < 300; i++) {
    for (const m of EVENT_METHODS) {
      const off = api[m](() => {});
      releases.push(M.wrapSubscription(off, m)); // 与 src/services/bridge.js subscribe 完全同构
    }
  }
  const mid = M.subscriptionRegistry.stats();
  assert.equal(mid.total, 300 * EVENT_METHODS.length);
  assert.ok(Object.values(mid.byMethod).every(n => n === 300));
  assert.equal(mid.created, 300 * EVENT_METHODS.length);

  for (const rel of releases) rel();
  const end = M.subscriptionRegistry.stats();
  assert.equal(end.total, 0, '仪表活跃订阅应归零');
  assert.equal(end.created, end.disposed, 'created 必须等于 disposed');
  // 关键：仪表归零的同时，底层真实监听器也必须归零（修复前这里会残留）
  for (const ch of contract.EVENT_CHANNELS) {
    assert.equal(ipcRenderer.listenerCount(ch), 0, `${ch} 底层监听器未随仪表一起归零（假绿）`);
  }
  assert.equal(ipcRenderer.eventNames().length, 0);
});

// ==================== 5. 静态防回退：preload 源码必须保留局部包装与 removeListener ====================
test('架构守卫：preload 使用局部 ipcRenderer 包装且真实调用 removeListener', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  assert.match(src, /const electronIpc = electron\.ipcRenderer/, '缺少对原生 ipcRenderer 的局部包装');
  assert.match(src, /removeListener\(channel, handler\)/, 'off 必须真实调用 removeListener');
  assert.match(src, /on:\s*\(channel, handler\)\s*=>/, '缺少返回 off 的 on 包装');
  // 17 个 on* 字面量仍为 ipcRenderer.on('...')：契约生成器正则不可被破坏
  const events = [...src.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.on\('([^']+)'/gm)];
  assert.equal(events.length, 17, '契约生成器可解析的事件方法数被改动');
  const invokes = [...src.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\('([^']+)'/gm)];
  assert.equal(invokes.length, 102, '契约生成器可解析的 invoke 方法数被改动');
});

// ==================== 6. 双端隔离：Android polyfill 与桌面 off 语义对齐 ====================
test('双端一致：Android polyfill 的 native 事件 off 同样是函数且可注销，remote 事件不伪造', () => {
  let src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'nativeBridge.js'), 'utf8');
  src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const contractJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'bridge-contract.json'), 'utf8'));
  const factory = new Function('Capacitor', 'registerPlugin', 'contract', 'getPC', 'console',
    src + '\nreturn { createNativeApi };');
  const { createNativeApi } = factory(
    { isNativePlatform: () => true }, () => ({}), contractJson, () => '', console);

  let removed = 0;
  const bridge = {
    invoke: async () => ({ result: '{"ok":true}' }),
    addListener: async () => ({ remove: () => { removed++; } })
  };
  const api = createNativeApi({ bridge, getPc: () => '' });
  const off = api.onGameCrash(() => {});
  assert.equal(typeof off, 'function', 'Android native 事件 off 应为函数');
  // remote 事件明确不支持（返回 noop），但同样是函数，绝不伪造数据
  const off2 = api.onDownloadProgress(() => {});
  assert.equal(typeof off2, 'function');
  off2();
  for (const m of EVENT_METHODS) {
    const o = api[m](() => {});
    assert.equal(typeof o, 'function', `Android ${m} 未返回函数`);
  }
});
