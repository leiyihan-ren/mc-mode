/**
 * speedtest.test.cjs — 0.9.0 模块一B：节点测速 TDD（纯 mock fetch，无公网）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../engine/net/speedtest.cjs');

// 真实墙钟语义：每个节点按各自的延迟 setTimeout，并发探测各自测到真实耗时。
// 延迟保持绝对差距（如 40ms vs 180ms），不做 /10 缩放：曾在与构建并行的高负载下，
// 4ms/18ms 的过小差距发生墙钟反转，导致 1 次偶发排序失败。拉大差距后排序可复现，
// 且仍是真实墙钟并发探测，不注入任何假延迟数字。
function mockFetch(latency) {
  const fetchImpl = async (url) => {
    const host = new URL(url).hostname;
    if (latency[host] === 'fail') throw new Error('connection refused');
    const ms = Math.max(0, (latency[host] ?? 100));
    await new Promise(r => setTimeout(r, ms));
    return { status: 206, body: { cancel: async () => {} }, headers: { get: () => 'bytes' } };
  };
  return { fetchImpl, now: () => Date.now() };
}

test('describeNode 识别 BMCLAPI / Mojang / 未知主机', () => {
  assert.equal(S.describeNode('https://bmclapi2.bangbang93.com/maven/x').id, 'bmclapi');
  assert.equal(S.describeNode('https://libraries.minecraft.net/x').id, 'mojang');
  assert.equal(S.describeNode('https://example.com/x').id, 'node');
});

test('nodeCandidates 从官方 URL 展开官方 + BMCLAPI 镜像，去重', () => {
  const list = S.nodeCandidates('https://libraries.minecraft.net/org/lwjgl/lwjgl.jar');
  assert.ok(list.length >= 2, '应有官方与镜像至少两个节点');
  assert.ok(list.some(u => /minecraft\.net/.test(u)));
  assert.ok(list.some(u => /bmclapi|bangbang93/.test(u)));
  assert.equal(new Set(list).size, list.length, '候选不得重复');
});

test('rankNodes：延迟最低的可用节点胜出，失败节点排最后且不伪造延迟', async () => {
  S.clearCache();
  const { fetchImpl, now } = mockFetch({ 'bmclapi2.bangbang93.com': 40, 'libraries.minecraft.net': 180 });
  const urls = ['https://libraries.minecraft.net/x', 'https://bmclapi2.bangbang93.com/x'];
  const r = await S.rankNodes(urls, { fetchImpl, now, timeoutMs: 1000, cacheTtlMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.winner.url, urls[1], 'BMCLAPI 更快应胜出');
  assert.ok(r.results[0].ok && r.results[1].ok, '两节点都应可用');
  assert.ok(r.results[0].latencyMs < r.results[1].latencyMs, '更快的节点延迟应更低');
});

test('rankNodes：一个节点失败时仍选出另一个可用节点，失败项 ok:false / latencyMs:null', async () => {
  S.clearCache();
  const { fetchImpl, now } = mockFetch({ 'bmclapi2.bangbang93.com': 'fail', 'libraries.minecraft.net': 90 });
  const r = await S.rankNodes(
    ['https://bmclapi2.bangbang93.com/x', 'https://libraries.minecraft.net/x'],
    { fetchImpl, now, timeoutMs: 1000, cacheTtlMs: 0 }
  );
  assert.equal(r.ok, true);
  assert.equal(r.winner.url, 'https://libraries.minecraft.net/x');
  const failed = r.results.find(x => x.url.includes('bmclapi'));
  assert.equal(failed.ok, false);
  assert.equal(failed.latencyMs, null, '失败节点不得伪造延迟数字');
});

test('rankNodes：所有节点不可用 → ok:false + 明确错误，不谎报', async () => {
  S.clearCache();
  const r = await S.rankNodes(
    ['https://a.invalid/x', 'https://b.invalid/x'],
    { fetchImpl: async () => { throw new Error('offline'); }, now: () => 0, timeoutMs: 1000, cacheTtlMs: 0 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.winner, null);
  assert.match(r.error, /不可用/);
  assert.ok(r.results.every(x => x.ok === false));
});

test('rankNodes：单点超时/异常不影响其它节点（allSettled 语义）', async () => {
  S.clearCache();
  let t = 0;
  const fetchImpl = async (url) => {
    if (url.includes('slow')) return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5));
    t += 12;
    return { status: 200, body: { cancel: async () => {} } };
  };
  const r = await S.rankNodes(['https://slow.invalid/x', 'https://fast.invalid/x'],
    { fetchImpl, now: () => t, timeoutMs: 1000, cacheTtlMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.winner.url, 'https://fast.invalid/x');
});

test('rankNodes TTL 缓存：命中后不再发起请求', async () => {
  S.clearCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 206, body: { cancel: async () => {} } }; };
  const opts = { fetchImpl, now: () => 1000, timeoutMs: 1000, cacheTtlMs: 5000 };
  const a = await S.rankNodes(['https://only.invalid/x'], opts);
  assert.equal(a.cached, false);
  assert.equal(calls, 1);
  const b = await S.rankNodes(['https://only.invalid/x'], opts);
  assert.equal(b.cached, true);
  assert.equal(calls, 1, '缓存命中不得再次测速');
  S.clearCache();
});

test('pickFastestNode：一步展开候选并给出最快 URL；全不可用时回落原 URL 且 benchmarked:false', async () => {
  S.clearCache();
  const { fetchImpl, now } = mockFetch({ 'bmclapi2.bangbang93.com': 30, 'libraries.minecraft.net': 200 });
  const r = await S.pickFastestNode('https://libraries.minecraft.net/x.jar', { fetchImpl, now, timeoutMs: 1000, cacheTtlMs: 0 });
  assert.equal(r.benchmarked, true);
  assert.match(r.chosenUrl, /bmclapi|bangbang93/, '应选更快的镜像');

  S.clearCache();
  const bad = await S.pickFastestNode('https://libraries.minecraft.net/x.jar',
    { fetchImpl: async () => { throw new Error('offline'); }, now: () => 0, timeoutMs: 1000, cacheTtlMs: 0 });
  assert.equal(bad.benchmarked, false);
  assert.equal(bad.chosenUrl, 'https://libraries.minecraft.net/x.jar', '不可用时回落原 URL');
});

test('rankNodes 空候选明确拒绝', async () => {
  const r = await S.rankNodes([], { cacheTtlMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /无候选/);
});
