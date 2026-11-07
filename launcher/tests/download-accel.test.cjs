'use strict';
/**
 * 模块三（0.4.0）：下载引擎多源加速单元测试。
 *  - BMCLAPI 首选 / Mojang 官方备用的真实 URL 顺序
 *  - 指数退避（含上限、抖动、可注入 sleepFn 保证确定性）
 *  - 失败换源、重试事件、旧策略向后兼容
 * 全程注入 fetchImpl/sleepFn，不依赖外网，不伪造成功状态。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mirrorCandidates, mirrorFirstCandidates, SOURCE_POLICY, OFFICIAL, BMCL
} = require('../engine/sources');
const { downloadFile, fetchJson, backoffDelay, DownloadError } = require('../engine/http');
const { downloadBatch } = require('../engine/downloader.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-accel-'));

/** 构造一个可被 http.js 流式读取的假响应 */
function fakeResponse(buf, status = 200) {
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => String(k).toLowerCase() === 'content-length' ? String(buf.length) : null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: buf };
        }
      })
    }
  };
}
function httpError(status) {
  return { ok: false, status, headers: { get: () => null }, body: null };
}

const OFFICIAL_LIB = 'https://libraries.minecraft.net/com/mojang/patching/1.0.0/patching-1.0.0.jar';

// ---------------------------------------------------------------- 纯函数：源顺序

test('mirrorFirstCandidates：官方 URL 变为 [BMCLAPI 镜像, 官方原 URL]', () => {
  const c = mirrorFirstCandidates(OFFICIAL_LIB);
  assert.equal(c.length, 2);
  assert.ok(c[0].startsWith(BMCL + '/maven/'), `首选应为 BMCLAPI，实际 ${c[0]}`);
  assert.equal(c[1], OFFICIAL_LIB, '官方源应作为备用兜底');
});

test('mirrorFirstCandidates：piston-data / version_manifest 同样镜像优先', () => {
  const asset = mirrorFirstCandidates('https://piston-data.mojang.com/v1/objects/' + 'a'.repeat(40) + '/icons/grass.png');
  assert.ok(asset[0].startsWith(BMCL + '/assets/'));
  const manifest = mirrorFirstCandidates(OFFICIAL.versionManifest);
  assert.equal(manifest[0], BMCL + '/mc/game/version_manifest_v2.json');
  assert.equal(manifest[manifest.length - 1], OFFICIAL.versionManifest);
});

test('mirrorFirstCandidates：无镜像主机 / 非法 URL 原样返回', () => {
  assert.deepEqual(mirrorFirstCandidates('https://example.com/foo.jar'), ['https://example.com/foo.jar']);
  assert.deepEqual(mirrorFirstCandidates('not-a-url'), ['not-a-url']);
});

test('旧 mirrorCandidates 保持「原 URL 优先」不被破坏（向后兼容）', () => {
  const c = mirrorCandidates(OFFICIAL_LIB);
  assert.equal(c[0], OFFICIAL_LIB);
  assert.ok(c[1].startsWith(BMCL));
  assert.equal(new Set(c).size, c.length);
});

test('SOURCE_POLICY 真实列出首选与备用，不含伪造状态', () => {
  assert.equal(SOURCE_POLICY.strategy, 'mirror-first');
  assert.equal(SOURCE_POLICY.primary.url, BMCL);
  assert.ok(SOURCE_POLICY.fallback.length >= 3);
  assert.ok(SOURCE_POLICY.fallback.every(f => /^https:\/\//.test(f.url)));
});

// ---------------------------------------------------------------- 纯函数：指数退避

test('backoffDelay 默认序列为 250/500/1000/2000 且封顶 8000', () => {
  assert.deepEqual([0, 1, 2, 3].map(n => backoffDelay(n)), [250, 500, 1000, 2000]);
  assert.equal(backoffDelay(10), 8000);
  assert.equal(backoffDelay(20), 8000);
});

test('backoffDelay 自定义 base/factor/max', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(n => backoffDelay(n, { backoffBaseMs: 100, backoffFactor: 3, backoffMaxMs: 1500 })),
    [100, 300, 900, 1500]
  );
});

test('backoffDelay 抖动可注入 random 保证确定性，且不越界', () => {
  const o = { backoffBaseMs: 1000, jitter: 0.2, random: () => 0 };
  assert.equal(backoffDelay(0, o), 800);        // 1000 * (1-0.2)
  assert.equal(backoffDelay(0, { ...o, random: () => 1 }), 1200); // 1000 * (1+0.2)
  assert.equal(backoffDelay(0, { ...o, random: () => 0.5 }), 1000);
});

test('backoffDelay 非法参数不崩溃、返回有限非负值', () => {
  for (const n of [-5, NaN, undefined, 'x']) {
    const d = backoffDelay(n, { backoffBaseMs: 200 });
    assert.ok(Number.isFinite(d) && d >= 0);
  }
  assert.equal(backoffDelay(0, { backoffBaseMs: 0 }), 0);
});

// ---------------------------------------------------------------- downloadFile：真实源顺序

test('downloadFile：BMCLAPI 首选，官方 URL 的首次请求即打到镜像', async () => {
  const dir = tmp();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return fakeResponse(Buffer.from('MIRROR-BYTES')); };
  const r = await downloadFile(OFFICIAL_LIB, path.join(dir, 'x.jar'), {
    fetchImpl, preferMirror: true, retries: 0
  });
  assert.equal(calls.length, 1, '镜像成功则不应再请求官方源');
  assert.ok(calls[0].startsWith(BMCL), `实际 ${calls[0]}`);
  assert.equal(r.usedUrl, calls[0]);
  assert.equal(fs.readFileSync(path.join(dir, 'x.jar'), 'utf8'), 'MIRROR-BYTES');
});

test('downloadFile：BMCLAPI 500 后自动降级到 Mojang 官方备用源', async () => {
  const dir = tmp();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? httpError(500) : fakeResponse(Buffer.from('OFFICIAL-BYTES'));
  };
  const r = await downloadFile(OFFICIAL_LIB, path.join(dir, 'x.jar'), {
    fetchImpl, preferMirror: true, retries: 0
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith(BMCL));
  assert.equal(calls[1], OFFICIAL_LIB);
  assert.equal(r.usedUrl, OFFICIAL_LIB);
  assert.equal(fs.readFileSync(path.join(dir, 'x.jar'), 'utf8'), 'OFFICIAL-BYTES');
});

test('downloadFile：preferMirror:false 时官方 URL 仍为首选（向后兼容）', async () => {
  const dir = tmp();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return fakeResponse(Buffer.from('OK')); };
  await downloadFile(OFFICIAL_LIB, path.join(dir, 'x.jar'), {
    fetchImpl, preferMirror: false, retries: 0
  });
  assert.equal(calls[0], OFFICIAL_LIB);
});

// ---------------------------------------------------------------- downloadFile：退避与事件

test('downloadFile：5xx 触发指数退避，延迟序列 250/500/1000 且发出 retry 事件', async () => {
  const dir = tmp();
  const delays = [], events = [];
  const fetchImpl = async () => httpError(503);
  await assert.rejects(
    downloadFile('http://127.0.0.1:1/x.jar', path.join(dir, 'x.jar'), {
      fetchImpl, retries: 3, timeoutMs: 2000,
      sleepFn: async (ms) => delays.push(ms),
      onRetry: (i) => events.push(i)
    }),
    (e) => e instanceof DownloadError
  );
  assert.deepEqual(delays, [250, 500, 1000], '指数退避序列');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(e => e.attempt), [1, 2, 3]);
  assert.deepEqual(events.map(e => e.delayMs), [250, 500, 1000]);
  assert.ok(events.every(e => e.url && e.maxAttempts === 4 && typeof e.error === 'string'));
});

test('downloadFile：4xx 立即换源不重试（避免无意义退避）', async () => {
  const dir = tmp();
  const delays = [];
  const fetchImpl = async () => httpError(404);
  await assert.rejects(
    downloadFile('http://127.0.0.1:1/x.jar', path.join(dir, 'x.jar'), {
      fetchImpl, retries: 3, sleepFn: async (ms) => delays.push(ms)
    }),
    DownloadError
  );
  assert.deepEqual(delays, [], '404 不应产生退避等待');
});

test('downloadFile：换源事件 switched=true 且带真实源索引', async () => {
  const dir = tmp();
  const events = [];
  const fetchImpl = async (url) => url.includes('bmclapi2') ? httpError(500) : fakeResponse(Buffer.from('OK'));
  await downloadFile(OFFICIAL_LIB, path.join(dir, 'x.jar'), {
    fetchImpl, preferMirror: true, retries: 0, onRetry: (i) => events.push(i)
  });
  assert.ok(events.some(e => e.switched === true && e.url === OFFICIAL_LIB && e.urlIndex === 1));
});

// ---------------------------------------------------------------- fetchJson

test('fetchJson：BMCLAPI 首选，失败后降级 Mojang 官方', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1
      ? { ok: false, status: 502 }
      : { ok: true, status: 200, json: async () => ({ versions: [] }) };
  };
  const j = await fetchJson(OFFICIAL.versionManifest, { fetchImpl, retries: 0, sleepFn: async () => {} });
  assert.deepEqual(j, { versions: [] });
  assert.ok(calls[0].startsWith(BMCL));
  assert.equal(calls[1], OFFICIAL.versionManifest);
});

test('fetchJson：重试延迟同样走指数退避', async () => {
  const delays = [];
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    fetchJson('http://example.invalid/x.json', {
      fetchImpl, retries: 2, sleepFn: async (ms) => delays.push(ms)
    }),
    DownloadError
  );
  assert.deepEqual(delays, [250, 500]);
});

// ---------------------------------------------------------------- DownloadQueue 透传

test('DownloadQueue 透传 preferMirror 并向上发出 retry 事件', async () => {
  const dir = tmp();
  const events = [];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? httpError(503) : fakeResponse(Buffer.from('OK'));
  };
  const { results } = await downloadBatch([{
    id: 'q1', url: OFFICIAL_LIB, dest: path.join(dir, 'q1.jar')
  }], {
    concurrency: 1, fetchImpl, retries: 1,
    sleepFn: async () => {},
    onEvent: (e) => events.push(e)
  });
  assert.equal(results[0].ok, true);
  assert.ok(calls[0].startsWith(BMCL), '队列层也应是镜像首选');
  assert.ok(events.some(e => e.type === 'retry' && e.id === 'q1'), '应发出 retry 事件');
  assert.ok(events.some(e => e.type === 'done'));
});
