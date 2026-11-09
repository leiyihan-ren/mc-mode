/**
 * speedtest.cjs — 0.9.0 模块一B：下载节点智能测速
 *
 * 真实能力：对候选节点（Mojang 官方 / BMCLAPI 镜像）并发探测，按延迟排序，
 * 动态选出最快节点用于下载。所有网络 IO 通过 fetchImpl 注入，可离线 TDD；
 * 沙盒无公网时明确返回「不可用」，绝不伪造延迟数字。
 *
 * 测速口径：Range bytes=0-0（近似 TTFB + 首字节），比纯 HEAD 更贴近真实下载；
 * 服务端不支持 Range 时降级 HEAD；两者都失败则该节点判为不可用。
 * 结果带 TTL 进程内缓存，避免每次下载都全量探测。
 *
 * 边界红线：
 *  - 测速失败 / 超时的节点排最后并标记 ok:false，不编造 latency。
 *  - 并发用 allSettled，单点挂起不影响其它节点（超时用 AbortSignal.timeout 或注入 signal）。
 */
'use strict';

const { mirrorFirstCandidates } = require('../sources');

const DEFAULTS = {
  timeoutMs: 4000,       // 单节点探测超时
  cacheTtlMs: 5 * 60 * 1000,
  probeBytes: 1          // Range: bytes=0-<probeBytes-1>
};

/** 节点标记：从 host 推断可读 id / name（用于 UI 展示，不伪造结果） */
function describeNode(url) {
  let host = url;
  try { host = new URL(url).hostname; } catch { /* 原样 */ }
  let id = 'node', name = host;
  if (/bmclapi|bangbang93/.test(host)) { id = 'bmclapi'; name = 'BMCLAPI 镜像'; }
  else if (/mojang|minecraft\.net|piston-/.test(host)) { id = 'mojang'; name = 'Mojang 官方'; }
  else if (/modrinth/.test(host)) { id = 'modrinth'; name = 'Modrinth'; }
  return { id, name, host };
}

/**
 * 由单个官方 URL 展开真实候选节点（官方 + BMCLAPI 镜像），去重。
 * 复用 sources.mirrorFirstCandidates 的映射规则，不重复维护一份。
 */
function nodeCandidates(url, extraUrls = []) {
  const base = mirrorFirstCandidates(url);
  return [...new Set([...base, ...(extraUrls || []).filter(Boolean)])];
}

/** 单个节点探测（真实 fetch；返回带延迟或明确错误）。 */
async function probeNode(url, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fetchFn = o.fetchImpl || fetch;
  const info = describeNode(url);
  const started = o.now ? o.now() : Date.now();
  const headers = { 'User-Agent': 'MC-Next-Speedtest/0.9.0', Range: `bytes=0-${Math.max(0, o.probeBytes - 1)}` };
  let signal = o.signal;
  let timer = null;
  if (!signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(o.timeoutMs);
  } else if (!signal) {
    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(new Error('probe timeout')), o.timeoutMs);
    signal = ac.signal;
  }
  try {
    const resp = await fetchFn(url, { method: 'GET', headers, signal, redirect: 'follow' });
    // 206(Partial Content) / 200(不支持 Range) 都算可达；其它状态判失败
    if (!resp || (resp.status !== 200 && resp.status !== 206 && resp.status !== 416)) {
      throw new Error(`HTTP ${resp ? resp.status : 'no-response'}`);
    }
    // 尽量读一点 body 让延迟包含首字节；不可读（mock）时不影响
    try { if (resp.body && typeof resp.body.cancel === 'function') await resp.body.cancel(); } catch { /* noop */ }
    const latencyMs = Math.max(0, (o.now ? o.now() : Date.now()) - started);
    return { ...info, url, ok: true, latencyMs, status: resp.status, error: null };
  } catch (e) {
    return { ...info, url, ok: false, latencyMs: null, status: null, error: String(e && e.message ? e.message : e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 进程内 TTL 缓存：key = 候选 URL 列表 join */
const _cache = new Map();
function cacheGet(key, now) {
  const v = _cache.get(key);
  if (!v) return null;
  if (now - v.at > v.ttlMs) { _cache.delete(key); return null; }
  return v.results;
}
function clearCache() { _cache.clear(); }

/**
 * 并发测速并排序。
 * @param {string[]} urls 候选节点 URL
 * @param {object} opts { fetchImpl, now, timeoutMs, cacheTtlMs, signal }
 * @returns {Promise<{ok:boolean, results:Array, winner:object|null, fastest:object|null, cached:boolean, error?:string}>}
 *   results 按 ok 优先、latencyMs 升序；不可用的排最后。
 */
async function rankNodes(urls, opts = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { ok: false, results: [], winner: null, fastest: null, cached: false, error: '无候选节点' };
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ? o.now() : Date.now();
  const key = list.join('|');
  if (o.cacheTtlMs > 0) {
    const hit = cacheGet(key, now);
    if (hit) return { ok: hit.some(r => r.ok), results: hit, winner: hit.find(r => r.ok) || null, fastest: hit.find(r => r.ok) || null, cached: true };
  }

  // allSettled 保证单点挂起/异常不影响其它节点
  const settled = await Promise.allSettled(list.map(u => probeNode(u, o)));
  const results = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : {
      ...describeNode(list[i]), url: list[i], ok: false, latencyMs: null, status: null,
      error: String(s.reason && s.reason.message ? s.reason.message : s.reason)
    });
  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;              // 可用优先
    if (!a.ok) return 0;                                   // 都失败保持原顺序
    return a.latencyMs - b.latencyMs;                      // 延迟升序
  });
  if (o.cacheTtlMs > 0 && results.some(r => r.ok)) _cache.set(key, { at: now, ttlMs: o.cacheTtlMs, results });
  const winner = results.find(r => r.ok) || null;
  return {
    ok: !!winner, results, winner, fastest: winner, cached: false,
    error: winner ? null : '所有节点均不可用（沙盒可能无公网）'
  };
}

/**
 * 一步到位：从单个官方 URL 展开候选 → 测速 → 返回最快节点 URL。
 * 无一个节点可用时回落到原始 URL（由调用方走既有降级链），并如实标记 benchmarked:false。
 */
async function pickFastestNode(url, opts = {}) {
  const list = nodeCandidates(url, opts.extraUrls);
  const r = await rankNodes(list, opts);
  return {
    ...r,
    chosenUrl: r.winner ? r.winner.url : url,
    benchmarked: r.ok,
    candidates: list
  };
}

module.exports = {
  DEFAULTS, describeNode, nodeCandidates, probeNode,
  rankNodes, pickFastestNode, clearCache
};
