'use strict';
/** 【0.6.0 模块一】两端 UI 大一统：指令契约 / WebView polyfill / 桌面远程 RPC 端到端测试 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const contract = require('../engine/bridge/contract.cjs');
const contractJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/bridge-contract.json'), 'utf8'));
const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.cjs'), 'utf8');

function parsePreload() {
  const invokes = [...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\('([^']+)'/gm)]
    .map(m => ({ method: m[1], channel: m[3] }));
  const events = [...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.on\('([^']+)'/gm)]
    .map(m => ({ method: m[1], channel: m[3] }));
  return { invokes, events };
}
const parsed = parsePreload();

// ==================== 1. 契约与 preload 单一数据源 ====================
test('契约覆盖 preload 全部 invoke 方法且映射逐一相等', () => {
  assert.ok(parsed.invokes.length >= 84, '基线至少 84 个方法');
  assert.equal(contract.INVOKE_CHANNELS.length, parsed.invokes.length);
  for (const { method, channel } of parsed.invokes) {
    assert.equal(contract.METHOD_MAP[method], channel, `方法 ${method} 映射漂移`);
    assert.ok(contract.INVOKE_CHANNELS.includes(channel));
  }
  assert.deepEqual(Object.keys(contract.METHOD_MAP).sort(), parsed.invokes.map(x => x.method).sort());
});

test('契约覆盖全部事件方法且无幽灵 channel', () => {
  assert.ok(parsed.events.length >= 11, '基线至少 11 个事件');
  assert.equal(contract.EVENT_CHANNELS.length, parsed.events.length);
  for (const { method, channel } of parsed.events) {
    assert.equal(contract.EVENT_METHOD_MAP[method], channel);
  }
  assert.equal(new Set(contract.INVOKE_CHANNELS).size, contract.INVOKE_CHANNELS.length);
  assert.equal(new Set(contract.EVENT_CHANNELS).size, contract.EVENT_CHANNELS.length);
});

test('落点分类：native 集合直达 JNI，其余全部 remote 转发 PC，未知拒绝', () => {
  const natives = contract.INVOKE_CHANNELS.filter(c => contract.classifyChannel(c) === 'native');
  const remotes = contract.INVOKE_CHANNELS.filter(c => contract.classifyChannel(c) === 'remote');
  assert.deepEqual([...natives].sort(), [...contract.NATIVE_CHANNELS].sort());
  assert.equal(remotes.length, contract.INVOKE_CHANNELS.length - natives.length);
  assert.equal(contract.classifyChannel('game:launch'), 'native');
  // 模块五：Android 热更新检查/下载必须落在 native，不能误转发到 PC
  assert.equal(contract.classifyChannel('update:check'), 'native');
  assert.equal(contract.classifyChannel('update:download'), 'native');
  assert.equal(contract.classifyChannel('jvm:preview'), 'remote');
  assert.equal(contract.classifyChannel('evil:exec'), 'unknown');
  assert.equal(contract.classifyEvent('game:log'), 'native');
  assert.equal(contract.classifyEvent('download:progress'), 'remote');
  assert.equal(contract.classifyEvent('evil:event'), 'unknown');
});

test('三端契约同源：JSON 与 Java 白名单包含每个 channel', () => {
  assert.deepEqual(contractJson.invoke, contract.INVOKE_CHANNELS);
  assert.deepEqual(contractJson.events, contract.EVENT_CHANNELS);
  assert.deepEqual(contractJson.native, contract.NATIVE_CHANNELS);
  const java = fs.readFileSync(
    path.join(ROOT, 'android/bridge/java/com/mcnext/launcher/BridgeContract.java'), 'utf8');
  for (const c of [...contract.INVOKE_CHANNELS, ...contract.EVENT_CHANNELS]) {
    assert.ok(java.includes(`"${c}"`), `Java 白名单缺少 ${c}`);
  }
  assert.ok(java.includes('isKnownInvoke') && java.includes('isNative') && java.includes('classify'));
});

test('JNI 指令桥 C 源码声明了真实底层动作（非占位）', () => {
  const c = fs.readFileSync(path.join(ROOT, 'android/bridge/jni/bridge_commands.c'), 'utf8');
  for (const s of ['Java_com_mcnext_launcher_BridgeNative_dispatch', 'DestroyJavaVM',
    'mcnext_input_push', 'setenv', 'jvm.requestStop', 'render.env', 'g_mcnext_vm']) {
    assert.ok(c.includes(s), `JNI 桥缺少 ${s}`);
  }
  const cmake = fs.readFileSync(path.join(ROOT, 'android/bridge/jni/CMakeLists.txt'), 'utf8');
  assert.ok(cmake.includes('bridge_commands.c') && cmake.includes('jvm_launcher.c'));
});

// ==================== 2. 渲染层 polyfill（加载真实源码，注入依赖） ====================
function loadPolyfill(deps = {}) {
  let src = fs.readFileSync(path.join(ROOT, 'src/lib/nativeBridge.js'), 'utf8');
  src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const factory = new Function(
    'Capacitor', 'registerPlugin', 'contract', 'getPC', 'console',
    src + '\nreturn { createNativeApi, shouldInstallNativeBridge, installNativeBridge, NATIVE_BRIDGE_FLAG };'
  );
  return factory(
    deps.Capacitor || { isNativePlatform: () => true },
    deps.registerPlugin || (() => ({})),
    contractJson,
    deps.getPC || (() => '192.168.1.9'),
    deps.console || console
  );
}

function fakeBridge(overrides = {}) {
  const calls = [];
  const bridge = {
    invoke: async (p) => { calls.push(p); return { result: JSON.stringify({ ok: true, echo: p }) }; },
    addListener: async (ch, cb) => { calls.push({ listener: ch, cb }); return { remove() {} }; },
    ...overrides
  };
  return { bridge, calls };
}

test('polyfill 生成与桌面同构的 window.mcnext（84 方法 + 11 事件 + 平台字段）', () => {
  const { createNativeApi } = loadPolyfill();
  const { bridge } = fakeBridge();
  const api = createNativeApi({ bridge, getPc: () => '' });
  for (const m of Object.keys(contract.METHOD_MAP)) assert.equal(typeof api[m], 'function', `缺方法 ${m}`);
  for (const m of Object.keys(contract.EVENT_METHOD_MAP)) assert.equal(typeof api[m], 'function', `缺事件 ${m}`);
  assert.equal(api.platform, 'android');
  assert.equal(api.isRoot, false);
  assert.equal(api.__native, true);
  assert.equal(api.isRemoteChannel('mods:list'), true);
  assert.equal(api.isRemoteChannel('game:launch'), false);
});

test('native 指令：不携带 PC 地址，argsJson 还原参数顺序，结果 JSON.parse 透传', async () => {
  const { createNativeApi } = loadPolyfill();
  const { bridge, calls } = fakeBridge();
  const api = createNativeApi({ bridge, getPc: () => '192.168.1.9' });
  const r = await api.launchGame({ versionId: '1.21.1', playerName: 'Steve' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'game:launch');
  assert.equal(calls[0].pc, '');
  assert.deepEqual(JSON.parse(calls[0].argsJson), [{ versionId: '1.21.1', playerName: 'Steve' }]);
});

test('remote 指令：携带 PC 地址，多参数按 preload 顺序原样透传', async () => {
  const { createNativeApi } = loadPolyfill();
  const { bridge, calls } = fakeBridge();
  const api = createNativeApi({ bridge, getPc: () => '10.0.0.7' });
  await api.worldBackup('/game', 'MyWorld', { label: 'before-mod' });
  assert.equal(calls[0].channel, 'world:backup');
  assert.equal(calls[0].pc, '10.0.0.7');
  assert.deepEqual(JSON.parse(calls[0].argsJson), ['/game', 'MyWorld', { label: 'before-mod' }]);
});

test('未知 channel 不触达原生桥，原生桥异常/坏格式都返回 ok:false 而不抛', async () => {
  const { createNativeApi } = loadPolyfill();
  const { bridge, calls } = fakeBridge();
  const api = createNativeApi({ bridge, getPc: () => '' });
  const bad = await api.invokeChannel('evil:exec', []);
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0);

  const bad2 = createNativeApi({ bridge: { invoke: async () => ({}) }, getPc: () => '' });
  assert.equal((await bad2.listClients()).ok, false);
  const bad3 = createNativeApi({ bridge: { invoke: async () => { throw new Error('JNI 断链'); } }, getPc: () => '' });
  assert.equal((await bad3.gameStatus()).ok, false);
});

test('事件：native 事件真实订阅并解析 payload；remote 事件不伪造数据', async () => {
  // 0.7.0 模块一：不再用 console.warn，改为可注入回调，控制台零噪声且行为可断言
  const unsupported = [];
  const onUnsupportedEvent = (channel) => unsupported.push(channel);
  const { createNativeApi } = loadPolyfill();
  const { bridge, calls } = fakeBridge();
  const api = createNativeApi({ bridge, getPc: () => '', onUnsupportedEvent });

  const got = [];
  const off = api.onGameLog(l => got.push(l));
  await new Promise(r => setImmediate(r));
  assert.equal(calls.filter(c => c.listener === 'game:log').length, 1);
  const listener = calls.find(c => c.listener === 'game:log');
  listener.cb({ payload: JSON.stringify({ level: 'info', text: 'JNI ready' }) });
  assert.deepEqual(got, [{ level: 'info', text: 'JNI ready' }]);
  assert.equal(typeof off, 'function');

  const off2 = api.onDownloadProgress(() => {});
  assert.equal(typeof off2, 'function');
  assert.deepEqual(unsupported, ['download:progress']);
  assert.equal(calls.filter(c => c.listener === 'download:progress').length, 0);
});

test('shouldInstallNativeBridge：桌面已有 preload 时不再注入', () => {
  const { shouldInstallNativeBridge } = loadPolyfill();
  assert.equal(shouldInstallNativeBridge(), false); // Node 环境 window undefined
});

// ==================== 3. 桌面端 dispatcher / 远程 RPC 端到端 ====================
function withStubbedElectron(fn) {
  const registry = new Map();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: (ch, cb) => { registry.set(ch, cb); return cb; } },
        dialog: { showOpenDialog: async () => ({ canceled: true }) },
        shell: { openExternal: async () => {} }
      };
    }
    return original.apply(this, arguments);
  };
  try {
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(null);
    return fn(ipc, registry);
  } finally {
    Module._load = original;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/electron/ipc.cjs') || k.includes('/electron/remoteControl.cjs')) delete require.cache[k];
    }
  }
}

test('桌面 registerIpc 注册全部真实 handler，dispatchChannel 可直接调用', async () => {
  await withStubbedElectron(async (ipc, registry) => {
    assert.equal(registry.size, contract.INVOKE_CHANNELS.length, `实际注册 ${registry.size}`);
    assert.equal(ipc.HANDLERS.size, contract.INVOKE_CHANNELS.length);
    assert.equal(ipc.hasChannel('download:sources'), true);
    const r = await ipc.dispatchChannel('download:sources');
    assert.ok(r && typeof r === 'object', 'download:sources 应返回真实源策略对象');
    const rel = await ipc.dispatchChannel('app:release');
    assert.ok(rel.page && rel.tag, 'app:release 应返回真实 Release 信息');
  });
});

test('/api/rpc 端到端：白名单放行并透传桌面 handler 结果，非法 channel 403，空 channel 400', async () => {
  await withStubbedElectron(async (ipc) => {
    const { handle } = require('../electron/remoteControl.cjs');
    const server = http.createServer(handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      const okRes = await post({ channel: 'download:sources', args: [] });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.json.ok, true);
      assert.equal(typeof okRes.json.result, 'string');
      const value = JSON.parse(okRes.json.result);
      assert.ok(value && typeof value === 'object');

      const relRes = await post({ channel: 'app:release', args: [] });
      assert.equal(JSON.parse(relRes.json.result).tag.length > 0, true);

      const deny = await post({ channel: 'evil:exec', args: [] });
      assert.equal(deny.status, 403);
      const empty = await post({ args: [] });
      assert.equal(empty.status, 400);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
