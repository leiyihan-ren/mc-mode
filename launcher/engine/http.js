/**
 * http.js — 带多源降级/重试/断点续传/SHA1 校验的下载器
 * 依赖 Node >= 18 全局 fetch。所有 IO 可注入，便于单测。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mirrorCandidates } = require('./sources');

const DEFAULTS = {
  timeoutMs: 60000,       // 单次请求超时（>60s 记录并绕过，符合防阻塞纪律）
  retries: 3,             // 单源重试次数
  mirrorRetries: 1,       // 换源后每个镜像的重试次数
  minTimeoutMs: 15000,    // 大文件放宽超时
  chunkSize: 1 << 20
};

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
  const urls = o.extraUrls && o.extraUrls.length
    ? [...new Set([url, ...o.extraUrls, ...mirrorCandidates(url).slice(1)])]
    : [...new Set([url, ...mirrorCandidates(url).slice(1)])];
  const tmp = dest + '.part';
  const errors = [];

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  for (const u of urls) {
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
        if (attempt < o.retries) await sleep(500 * (attempt + 1));
      }
    }
  }
  throw new DownloadError(`下载失败（${url}）: ${errors[errors.length - 1] || '未知错误'}`, { urls });
}

/** 获取 JSON，自动多源降级 */
async function fetchJson(url, opts = {}) {
  const urls = [...new Set([url, ...mirrorCandidates(url).slice(1)])];
  const o = { timeoutMs: 30000, retries: 2, ...opts };
  const errors = [];
  for (const u of urls) {
    for (let i = 0; i <= o.retries; i++) {
      try {
        const resp = await fetchWithTimeout(u, o.timeoutMs, o.fetchImpl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) {
        errors.push(`${u}: ${e.message}`);
        if (i < o.retries) await sleep(400 * (i + 1));
      }
    }
  }
  throw new DownloadError(`JSON 获取失败（${url}）: ${errors[errors.length - 1]}`, { urls });
}

module.exports = { downloadFile, fetchJson, fetchWithTimeout, DownloadError, DEFAULTS };
