/**
 * smart-download-integration.test.cjs — 0.9.0 模块一B：节点测速 / 智能并发下载 IPC 集成测试（E2E 级）
 *
 * 用 stubbed Electron + 假 BrowserWindow（捕获 send 事件）+ stub 网络引擎，真实跑一遍
 * registerIpc → dispatchChannel('download:benchmark' / 'download:smart')，断言：
 *   - 两个新 channel 已注册且落在契约白名单（remote 分类，Android 转发 PC）
 *   - 测速结果 / 无公网如实报错 / 传 urls 优先
 *   - 智能下载：测速选最快节点 → 并发分块成功 → 发 download:done(mode=parallel)
 *   - 回退链：并发 fallback → 单连接多源（不误发 retry）；并发失败 → 发 retry 后回退
 *   - 全失败 → download:error；参数校验；测速异常不阻断下载；benchmark/parallel 开关
 *
 * 真实算法（延迟排序 / Range 分块 / 断点续传 / SHA1）已由 speedtest.test.cjs(9) 与
 * parallelDownload.test.cjs(10) 覆盖；本套件聚焦 IPC 接线 + 事件 + 回退编排，
 * 网络全部用协议级 stub，不触真实公网，符合沙盒边界。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function withStubs(fn) {
  const captured = {
    sent: [],           // { channel, payload }
    benchmarkCalls: [], // rankNodes 参数
    pickCalls: [],      // pickFastestNode 参数
    parallelCalls: [],  // downloadParallel 参数
    singleCalls: []     // downloadFile 参数
  };
  // 每个用例可设置的行为；所有返回值均由用例显式给出，测试内零伪造网络结果
  const behavior = {
    rank: null, pick: null, parallel: null, single: null,
    progress: false, singleRetry: false
  };
  const original = Module._load;

  const fakeElectron = {
    ipcMain: { handle: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal: async () => {} }
  };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => captured.sent.push({ channel, payload }) }
  };

  const fakeHttp = {
    downloadFile: async (url, dest, opts) => {
      captured.singleCalls.push({ url, dest, opts });
      if (behavior.single && behavior.single.throw) throw new Error(behavior.single.throw);
      if (behavior.progress && opts && typeof opts.onProgress === 'function') opts.onProgress(50, 100);
      if (behavior.singleRetry && opts && typeof opts.onRetry === 'function') {
        opts.onRetry({ urlIndex: 1, urlCount: 2, switched: true, attempt: 1, maxAttempts: 3, delayMs: 200 });
      }
      return behavior.single;
    },
    fetchJson: async () => ({})
  };
  const fakeSpeedtest = {
    nodeCandidates: (url, extra) => [url, ...(extra || [])],
    rankNodes: async (urls, opts) => { captured.benchmarkCalls.push({ urls, opts }); return behavior.rank; },
    pickFastestNode: async (url, opts) => {
      captured.pickCalls.push({ url, opts });
      if (behavior.pick && behavior.pick.throw) throw new Error(behavior.pick.throw);
      return behavior.pick;
    },
    clearCache: () => {}
  };
  const fakeParallel = {
    downloadParallel: async (url, dest, opts) => {
      captured.parallelCalls.push({ url, dest, opts });
      if (behavior.parallel && behavior.parallel.throw) throw new Error(behavior.parallel.throw);
      return behavior.parallel;
    }
  };

  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    if (request === '../engine/net/speedtest.cjs') return fakeSpeedtest;
    if (request === '../engine/net/parallelDownload.cjs') return fakeParallel;
    if (request === '../engine/http' || request === '../engine/http.js' ||
        request === './http' || request === '../http') return fakeHttp;
    return original.apply(this, arguments);
  };

  const clearIpcCache = () => {
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/electron/ipc.cjs')) delete require.cache[k];
    }
  };
  clearIpcCache();
  const loadIpc = () => {
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(fakeWindow);
    return ipc;
  };

  return Promise.resolve(fn({ captured, behavior, loadIpc })).finally(() => {
    Module._load = original;
    clearIpcCache();
  });
}

const TASK = (extra) => ({
  id: '1.20.1', url: 'https://launcher.mojang.com/v1/objects/abc/client.jar',
  dest: '/tmp/mcnext-1.20.1.jar', sha1: 'deadbeef', ...extra
});
const ev = (captured, channel) => captured.sent.filter(e => e.channel === channel);

test('两个新 channel 已注册且落在契约白名单，分类为 remote（Android 转发 PC 而非直落 JNI）', async () => {
  await withStubs(async ({ loadIpc }) => {
    const ipc = loadIpc();
    assert.equal(ipc.hasChannel('download:benchmark'), true);
    assert.equal(ipc.hasChannel('download:smart'), true);
    const c = require('../engine/bridge/contract.cjs');
    assert.equal(c.INVOKE_CHANNELS.includes('download:benchmark'), true);
    assert.equal(c.INVOKE_CHANNELS.includes('download:smart'), true);
    assert.equal(c.classifyChannel('download:smart'), 'remote');
    assert.equal(c.METHOD_MAP.benchmarkDownload, 'download:benchmark');
    assert.equal(c.METHOD_MAP.smartDownload, 'download:smart');
    // 同名方法应被 Service 层从契约 methodMap 自动生成（前端可调用）
    const j = require('../src/lib/bridge-contract.json');
    assert.equal(j.methodMap.smartDownload, 'download:smart');
  });
});

test('download:benchmark 成功：返回按延迟排序的结果与最快节点，note 标明真实探测', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.rank = {
      ok: true, cached: false, error: null,
      results: [
        { id: 'bmclapi', name: 'BMCLAPI 镜像', url: 'https://bmclapi2/mirror', ok: true, latencyMs: 42 },
        { id: 'mojang', name: 'Mojang 官方', url: 'https://mojang/official', ok: true, latencyMs: 130 }
      ],
      winner: { id: 'bmclapi', name: 'BMCLAPI 镜像', url: 'https://bmclapi2/mirror', latencyMs: 42 }
    };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:benchmark', { url: 'https://launchermeta.mojang.com/x.json' });
    assert.equal(r.ok, true);
    assert.equal(r.winner.latencyMs, 42);
    assert.equal(r.winner.name, 'BMCLAPI 镜像');
    assert.equal(r.results.length, 2);
    assert.ok(r.results[0].latencyMs <= r.results[1].latencyMs, '结果按延迟升序');
    assert.match(r.note, /真实并发探测/);
    assert.equal(captured.benchmarkCalls.length, 1);
  });
});

test('download:benchmark 无公网：如实报错、winner=null、不伪造任何延迟数字', async () => {
  await withStubs(async ({ behavior, loadIpc }) => {
    behavior.rank = {
      ok: false, cached: false, error: '所有节点均不可用（沙盒可能无公网）',
      results: [{ ok: false, latencyMs: null, error: 'timeout' }, { ok: false, latencyMs: null, error: 'ECONNREFUSED' }],
      winner: null
    };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:benchmark', { urls: ['u1', 'u2'] });
    assert.equal(r.ok, false);
    assert.equal(r.winner, null);
    assert.match(r.note, /不伪造/);
    assert.ok(r.results.every(x => x.latencyMs === null), '不可用节点延迟必须为 null');
  });
});

test('download:benchmark 传 urls 优先；未传时展开 nodeCandidates', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.rank = { ok: true, cached: true, results: [{ ok: true, latencyMs: 10 }], winner: { name: 'n', latencyMs: 10 } };
    const ipc = loadIpc();
    await ipc.dispatchChannel('download:benchmark', { urls: ['A', 'B'], url: 'IGNORED', timeoutMs: 1234 });
    assert.deepEqual(captured.benchmarkCalls[0].urls, ['A', 'B']);
    assert.equal(captured.benchmarkCalls[0].opts.timeoutMs, 1234);
    const r2 = await ipc.dispatchChannel('download:benchmark', { url: 'https://launchermeta.mojang.com/m.json' });
    assert.equal(r2.cached, true);
    assert.deepEqual(captured.benchmarkCalls[1].urls, ['https://launchermeta.mojang.com/m.json']);
  });
});

test('download:smart 并发成功：用最快节点分块，发 done(mode=parallel)，不回退单连接', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { ok: true, benchmarked: true, chosenUrl: 'https://bmclapi2/fast.jar', winner: { name: 'BMCLAPI 镜像' } };
    behavior.parallel = { ok: true, sha1: 'deadbeef', size: 10485760, chunks: 4, resumed: 0, downloaded: 4 };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK());
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'parallel');
    assert.equal(r.chunks, 4);
    assert.equal(r.usedUrl, 'https://bmclapi2/fast.jar');
    assert.equal(r.benchmarked, true);
    assert.equal(captured.pickCalls.length, 1, '应先测速');
    assert.equal(captured.parallelCalls[0].url, 'https://bmclapi2/fast.jar', '并发下载必须用最快节点');
    assert.equal(captured.parallelCalls[0].opts.expectedSha1, 'deadbeef');
    assert.equal(captured.singleCalls.length, 0, '并发成功不应回退单连接');
    const done = ev(captured, 'download:done');
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.mode, 'parallel');
    assert.equal(done[0].payload.chunks, 4);
    assert.equal(done[0].payload.id, '1.20.1');
    assert.equal(ev(captured, 'download:error').length, 0);
    assert.equal(ev(captured, 'download:retry').length, 0);
  });
});

test('download:smart 并发 fallback（不支持 Range / 小文件）：回退单连接且不误发 retry 事件', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { ok: true, benchmarked: true, chosenUrl: 'https://bmclapi2/fast.jar' };
    behavior.parallel = { ok: false, fallback: true, size: 0, error: '服务端不支持分块或文件过小，回退单连接下载' };
    behavior.single = { ok: true, sha1: 'deadbeef', size: 512 };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK());
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'single');
    assert.equal(captured.singleCalls[0].url, 'https://bmclapi2/fast.jar');
    assert.equal(ev(captured, 'download:retry').length, 0, 'fallback 是预期行为，不应报 retry');
    assert.equal(ev(captured, 'download:done')[0].payload.mode, 'single');
  });
});

test('download:smart 并发失败（非 fallback）：先发 retry(switched) 再回退单连接', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { ok: true, benchmarked: true, chosenUrl: 'https://bmclapi2/fast.jar' };
    behavior.parallel = { ok: false, fallback: false, size: 100, error: 'chunk 2 失败' };
    behavior.single = { ok: true, sha1: 'deadbeef', size: 100 };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK());
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'single');
    const retries = ev(captured, 'download:retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].payload.switched, true);
    assert.match(retries[0].payload.error, /并发下载回退/);
    assert.equal(ev(captured, 'download:done')[0].payload.mode, 'single');
  });
});

test('download:smart 并发与单连接全失败：发 download:error 且返回 ok:false', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { ok: false, benchmarked: false, chosenUrl: TASK().url };
    behavior.parallel = { ok: false, fallback: true, error: 'no range' };
    behavior.single = { throw: '网络不可达' };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK());
    assert.equal(r.ok, false);
    assert.match(r.error, /网络不可达/);
    const errs = ev(captured, 'download:error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.id, '1.20.1');
    assert.equal(ev(captured, 'download:done').length, 0);
  });
});

test('download:smart 参数校验：缺 url / dest 明确拒绝，不触发任何下载', async () => {
  await withStubs(async ({ captured, loadIpc }) => {
    const ipc = loadIpc();
    const r1 = await ipc.dispatchChannel('download:smart', { dest: '/tmp/x' });
    const r2 = await ipc.dispatchChannel('download:smart', { url: 'u' });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.match(r1.error, /缺少 url 或 dest/);
    assert.equal(captured.parallelCalls.length, 0);
    assert.equal(captured.singleCalls.length, 0);
  });
});

test('download:smart benchmark:false / parallel:false：跳过测速与并发，直接用原始 URL 单连接', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.single = { ok: true, sha1: 'deadbeef', size: 8 };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK({ benchmark: false, parallel: false }));
    assert.equal(captured.pickCalls.length, 0, 'benchmark:false 应跳过测速');
    assert.equal(captured.parallelCalls.length, 0, 'parallel:false 应跳过并发');
    assert.equal(captured.singleCalls.length, 1);
    assert.equal(captured.singleCalls[0].url, TASK().url, '应使用原始 URL');
    assert.equal(r.mode, 'single');
    assert.equal(r.benchmarked, false);
  });
});

test('测速异常不阻断下载：回落原始 URL，benchmarked=false', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { throw: 'probe crashed' };
    behavior.parallel = { ok: true, sha1: 'deadbeef', size: 2048, chunks: 2, resumed: 0, downloaded: 2 };
    const ipc = loadIpc();
    const r = await ipc.dispatchChannel('download:smart', TASK());
    assert.equal(r.ok, true);
    assert.equal(r.usedUrl, TASK().url, '测速抛错应回落原始 URL');
    assert.equal(r.benchmarked, false);
    assert.equal(captured.parallelCalls[0].url, TASK().url);
    assert.equal(ev(captured, 'download:done')[0].payload.mode, 'parallel');
  });
});

test('单连接回退时 onProgress / onRetry 正确转发为 download:progress / download:retry 事件', async () => {
  await withStubs(async ({ captured, behavior, loadIpc }) => {
    behavior.pick = { ok: false, benchmarked: false, chosenUrl: TASK().url };
    behavior.parallel = { ok: false, fallback: true, error: 'no range' };
    behavior.single = { ok: true, sha1: 'deadbeef', size: 100 };
    behavior.progress = true;
    behavior.singleRetry = true;
    const ipc = loadIpc();
    await ipc.dispatchChannel('download:smart', TASK());
    const progs = ev(captured, 'download:progress');
    assert.equal(progs.length, 1);
    assert.equal(progs[0].payload.received, 50);
    assert.equal(progs[0].payload.total, 100);
    const retries = ev(captured, 'download:retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].payload.urlIndex, 1);
    assert.equal(retries[0].payload.urlCount, 2);
  });
});
