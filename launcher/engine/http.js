/**
 * http.js — 带多源降级/重试/断点续传/SHA1 校验的下载器
 * 依赖 Node >= 18 全局 fetch。所有 IO 可注入，便于单测。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mirrorCandidates, mirrorFirstCandidates } = require('./sources');

const DEFAULTS = {
  timeoutMs: 60000,       // 单次请求超时（>60s 记录并绕过，符合防阻塞纪律）
  retries: 3,             // 单源重试次数
  mirrorRetries: 1,       // 换源后每个镜像的重试次数
  minTimeoutMs: 15000,    // 大文件放宽超时
  chunkSize: 1 << 20,
  // —— 0.4.0 模块三：多源加速 + 指数退避 ——
  preferMirror: true,     // BMCLAPI 首选、Mojang 官方备用
  backoffBaseMs: 250,     // 第 1 次重试前等待
  backoffFactor: 2,       // 每次 ×2
  backoffMaxMs: 8000,     // 退避上限
  jitter: 0               // 抖动比例（0~0.5）；单测用 0 保证确定性，可注入 random
};

/**
 * 【0.4.0】指数退避延迟（纯函数，无 IO，可独立单测）。
 *   attempt 从 0 开始：base, base*factor, base*factor^2 ... 上限 max。
 *   jitter>0 时在 [raw*(1-j), raw*(1+j)] 之间浮动，random 可注入以便确定性测试。
 */
function backoffDelay(attempt, opts = {}) {
  const base = Number(opts.backoffBaseMs ?? DEFAULTS.backoffBaseMs);
  const max = Number(opts.backoffMaxMs ?? DEFAULTS.backoffMaxMs);
  const factor = Number(opts.backoffFactor ?? DEFAULTS.backoffFactor);
  const jitter = Math.min(0.9, Math.max(0, Number(opts.jitter ?? DEFAULTS.jitter)));
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const raw = Math.min(base * Math.pow(factor, n), max);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (jitter === 0) return Math.round(raw);
  const rand = typeof opts.random === 'function' ? opts.random() : Math.random();
  return Math.max(0, Math.round(raw * (1 - jitter + 2 * jitter * Math.min(1, Math.max(0, rand)))));
}

class DownloadError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DownloadError';
    this.urls = opts.urls || [];
    this.cause = opts.cause;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 带超时的 fetch（AbortController） */
async function fetchWithTimeout(url, timeoutMs, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchFn(url, { signal: ac.signal, headers: { 'User-Agent': 'mc-next/0.1' }, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** 合并两个 AbortSignal（Node 20+ 用 AbortSignal.any，低版本回退） */
function anySignal(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  const forward = () => c.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  if (a.aborted || b.aborted) c.abort();
  return c.signal;
}

/**
 * 下载文件到 dest（原子写入：先写 .part 再 rename）。
 * @param {string} url 首选 URL（会自动追加镜像）
 * @param {string} dest 目标路径
 * @param {object} opts { timeoutMs, retries, onProgress(bytes,total), expectedSha1, totalBytesHint, minTimeoutMs }
 * @returns {Promise<{sha1:string, size:number, usedUrl:string}>}
 */
async function downloadFile(url, dest, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fetchFn = o.fetchImpl || fetch;
  const sleepFn = o.sleepFn || sleep;
  const extras = o.extraUrls && o.extraUrls.length ? o.extraUrls : [];
  const mirrorChain = mirrorCandidates(url).slice(1); // 真实 BMCLAPI 镜像
  let urls;
  if (o.preferMirror === false) {
    // 兼容旧策略：官方原 URL 首选
    urls = [...new Set([url, ...extras, ...mirrorChain])];
  } else {
    const mf = mirrorFirstCandidates(url); // [镜像..., 官方] 或 [url]
    if (mf.length > 1) {
      // 有真实镜像：BMCLAPI 镜像 → 显式备用源 → Mojang 官方兜底
      urls = [...new Set([...mf.slice(0, -1), ...extras, mf[mf.length - 1]])];
    } else {
      // 无镜像（本地测试端点 / 第三方 URL）：保持原 URL 首选，不擅自改顺序
      urls = [...new Set([url, ...extras, ...mirrorChain])];
    }
  }
  const tmp = dest + '.part';
  const errors = [];

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  for (let ui = 0; ui < urls.length; ui++) {
    const u = urls[ui];
    // 换源时上报（供 UI 展示「BMCLAPI → Mojang 官方」真实切换过程）
    if (ui > 0 && typeof o.onRetry === 'function') {
      try {
        o.onRetry({
          url: u, switched: true, attempt: 0, maxAttempts: o.retries + 1,
          delayMs: 0, error: '上一源失败，切换备用源', urlIndex: ui, urlCount: urls.length
        });
      } catch { /* 事件消费者异常不影响下载 */ }
    }
    // 断点续传：已下载字节数
    let have = 0;
    if (fs.existsSync(tmp)) {
      try { have = fs.statSync(tmp).size; } catch { have = 0; }
    }
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      const headers = { 'User-Agent': 'mc-next/0.1' };
      if (have > 0) headers['Range'] = `bytes=${have}-`;
      const timeout = Math.max(o.timeoutMs, o.minTimeoutMs);
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout);
        const resp = await fetchFn(u, { signal: anySignal(ac.signal, o.signal), headers, redirect: 'follow' });
        clearTimeout(timer);

        if (resp.status === 416 && have > 0) {
          // Range 越界：文件已完整，直接校验
          break;
        }
        if (!resp.ok || (resp.status !== 200 && resp.status !== 206)) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const total = Number(resp.headers.get('content-length') || 0) + (resp.status === 206 ? have : 0);
        const stream = fs.createWriteStream(tmp, have > 0 && resp.status === 206 ? { flags: 'a' } : { flags: 'w' });
        const hash = crypto.createHash('sha1');
        if (have > 0 && resp.status === 206) {
          // 续传：先哈希已有部分
          await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(tmp, { end: have - 1 });
            rs.on('data', c => hash.update(c));
            rs.on('error', reject);
            rs.on('end', resolve);
          });
        }
        let received = have;
        await new Promise((resolve, reject) => {
          const reader = resp.body.getReader();
          const pump = async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!stream.write(value)) await new Promise(r => stream.once('drain', r));
                hash.update(value);
                received += value.length;
                if (o.onProgress) o.onProgress(received, total || (o.totalBytesHint || 0));
              }
              stream.end(() => resolve());
            } catch (e) { reject(e); }
          };
          pump();
        });
        // flush hash of written stream
        const sha1 = hash.digest('hex');
        const size = fs.statSync(tmp).size;
        if (o.expectedSha1 && sha1 !== o.expectedSha1.toLowerCase()) {
          throw new Error(`SHA1 不符: 期望 ${o.expectedSha1} 实际 ${sha1}`);
        }
        fs.renameSync(tmp, dest);
        return { sha1, size, usedUrl: u };
      } catch (e) {
        errors.push(`${u}: ${e.message}`);
        // 外部主动取消：不重试、不换源，立即冒泡
        if (o.signal && o.signal.aborted) throw e;
        // 网络类错误才重试；HTTP 4xx（除429）直接换源
        const msg = String(e.message || e);
        if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) break;
        if (attempt < o.retries) {
          const delayMs = backoffDelay(attempt, o);
          if (typeof o.onRetry === 'function') {
            try {
              o.onRetry({
                url: u, switched: false, attempt: attempt + 1, maxAttempts: o.retries + 1,
                delayMs, error: msg, urlIndex: ui, urlCount: urls.length
              });
            } catch { /* noop */ }
          }
          await sleepFn(delayMs);
        }
      }
    }
  }
  throw new DownloadError(`下载失败（${url}）: ${errors[errors.length - 1] || '未知错误'}`, { urls });
}

/** 获取 JSON，自动多源降级（0.4.0：BMCLAPI 首选 + 指数退避） */
async function fetchJson(url, opts = {}) {
  const o = { ...DEFAULTS, timeoutMs: 30000, retries: 2, ...opts };
  const sleepFn = o.sleepFn || sleep;
  const mf = o.preferMirror === false
    ? [url, ...mirrorCandidates(url).slice(1)]
    : mirrorFirstCandidates(url);
  const extras = o.extraUrls && o.extraUrls.length ? o.extraUrls : [];
  const urls = [...new Set([...mf, ...extras])];
  const errors = [];
  for (const u of urls) {
    for (let i = 0; i <= o.retries; i++) {
      try {
        const resp = await fetchWithTimeout(u, o.timeoutMs, o.fetchImpl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) {
        errors.push(`${u}: ${e.message}`);
        if (o.signal && o.signal.aborted) throw e;
        if (i < o.retries) {
          const delayMs = backoffDelay(i, o);
          if (typeof o.onRetry === 'function') {
            try {
              o.onRetry({
                url: u, switched: false, attempt: i + 1, maxAttempts: o.retries + 1,
                delayMs, error: String(e.message || e)
              });
            } catch { /* noop */ }
          }
          await sleepFn(delayMs);
        }
      }
    }
  }
  throw new DownloadError(`JSON 获取失败（${url}）: ${errors[errors.length - 1]}`, { urls });
}

module.exports = {
  downloadFile, fetchJson, fetchWithTimeout, DownloadError, DEFAULTS, backoffDelay
};
