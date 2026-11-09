/**
 * parallelDownload.cjs — 0.9.0 模块一B：单文件多线程并发下载 + 断点续传
 *
 * 与既有 http.downloadFile（单连接、多源降级）互补：这里针对**单个大文件**
 * 用 Range 切成 N 块并发下载，显著提升大文件吞吐；同时保留逐块 .part 断点续传。
 *
 * 真实流程：
 *   1. probe：HEAD / Range 拿 Content-Length 与 Accept-Ranges；不支持分块 → 明确回退信号
 *   2. planChunks：纯函数把 [0,size) 切成 N 段
 *   3. 并发下载各段到 dest.part.<i>（受 concurrency 限制），已完整存在的段跳过 = 断点续传
 *   4. 每段校验字节数；全部成功后按序合并到 dest.part.merged，整体 sha1 校验
 *   5. 原子 rename 到 dest，清理所有临时块
 *
 * 边界红线：
 *  - 所有网络/文件 IO 可注入（fetchImpl / fsImpl），离线 TDD 不碰真实文件与公网。
 *  - 段缺失/长度不符/整体 sha1 不符一律报错并保留 .part 供续传，绝不产出损坏的成品。
 *  - 服务端不支持 Range 或文件过小 → 返回 fallback:true，由调用方走 http.downloadFile。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  concurrency: 4,
  minChunkSize: 1 << 20,   // 1MB，小于此不分块（避免调度开销大于收益）
  maxChunks: 8,
  timeoutMs: 60000
};

/**
 * 纯函数：把 [0,size) 切成 n 段，返回 [{index,start,end,length}]（end 含）。
 * 空文件返回单段；n 会被收敛到 [1, maxChunks]。
 */
function planChunks(size, requested, opts = {}) {
  const maxChunks = opts.maxChunks || DEFAULTS.maxChunks;
  const s = Math.max(0, Math.floor(Number(size) || 0));
  if (s === 0) return [{ index: 0, start: 0, end: 0, length: 1 }];
  const n = Math.max(1, Math.min(maxChunks, Math.floor(Number(requested) || 1)));
  const per = Math.ceil(s / n);
  const chunks = [];
  let start = 0;
  let i = 0;
  while (start < s && i < n) {
    const end = Math.min(s - 1, start + per - 1);
    chunks.push({ index: i, start, end, length: end - start + 1 });
    start = end + 1;
    i++;
  }
  return chunks;
}

/** 是否应走并发分块（纯判定，供调用方快速决策） */
function shouldParallel(size, acceptRanges, minChunkSize) {
  const min = minChunkSize || DEFAULTS.minChunkSize;
  return !!(acceptRanges && size && size > min);
}

/**
 * 探测远端文件：返回 { size, acceptRanges }。真实 fetch，可注入。
 * 优先 HEAD；HEAD 被拒(405/403)时用 Range bytes=0-0 兜底探测。
 */
async function probe(url, opts = {}) {
  const fetchFn = opts.fetchImpl || fetch;
  const headers = { 'User-Agent': 'MC-Next-Parallel/0.9.0' };
  let resp;
  try {
    resp = await fetchFn(url, { method: 'HEAD', headers, signal: opts.signal });
  } catch (e) {
    throw new Error(`探测失败(HEAD): ${e.message}`);
  }
  if (!resp) throw new Error('探测失败：无响应');
  let size = Number(resp.headers && resp.headers.get ? resp.headers.get('content-length') : 0) || 0;
  let acceptRanges = /bytes/i.test(String((resp.headers && resp.headers.get ? resp.headers.get('accept-ranges') : '') || ''));
  // HEAD 不允许或没给长度 → 用 Range 探测
  if (resp.status === 405 || resp.status === 403 || !size) {
    const r2 = await fetchFn(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, signal: opts.signal });
    if (!r2) throw new Error('探测失败(Range)：无响应');
    const cr = String((r2.headers && r2.headers.get ? r2.headers.get('content-range') : '') || '');
    const m = /bytes\s+0-0\/(\d+)/i.exec(cr);
    if (m) { size = Number(m[1]); acceptRanges = true; }
    else if (r2.status === 206) acceptRanges = true;
    try { if (r2.body && typeof r2.body.cancel === 'function') await r2.body.cancel(); } catch { /* noop */ }
  }
  return { size, acceptRanges };
}

/**
 * 并发分块下载。
 * @returns {Promise<{ok:boolean, fallback?:boolean, sha1?:string, size?:number, chunks?:number, resumed?:number, error?:string}>}
 */
async function downloadParallel(url, dest, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const fetchFn = o.fetchImpl || fetch;
  const F = o.fsImpl || fs;
  F.mkdirSync(path.dirname(dest), { recursive: true });

  // 1. 探测（可注入 probeResult 供离线测试跳过网络）
  let meta = o.probeResult;
  if (!meta) {
    try { meta = await probe(url, { fetchImpl: fetchFn, signal: o.signal }); }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const { size, acceptRanges } = meta;
  if (!shouldParallel(size, acceptRanges, o.minChunkSize)) {
    return { ok: false, fallback: true, size, error: '服务端不支持分块或文件过小，回退单连接下载' };
  }

  const chunks = planChunks(size, o.concurrency, o);
  const partPath = (c) => `${dest}.part.${c.index}`;
  // 显式 retries:0 必须生效（0 是 falsy，不能用 || 1）
  const retries = o.retries === undefined ? 1 : Math.max(0, Number(o.retries));
  let resumed = 0;

  // 2. 并发下载各段（有限并发 worker，避免打爆带宽/句柄）
  const queue = chunks.slice();
  const failures = [];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const pp = partPath(c);
      // 断点续传：已存在且长度正确的段直接跳过
      try {
        if (F.existsSync(pp) && F.statSync(pp).size === c.length) { resumed++; continue; }
      } catch { /* 重新下载 */ }
      let ok = false;
      for (let attempt = 0; attempt <= retries && !ok; attempt++) {
        try {
          const resp = await fetchFn(url, {
            method: 'GET',
            headers: { 'User-Agent': 'MC-Next-Parallel/0.9.0', Range: `bytes=${c.start}-${c.end}` },
            signal: o.signal
          });
          if (!resp || (resp.status !== 206 && resp.status !== 200)) throw new Error(`HTTP ${resp ? resp.status : 'no-response'}`);
          // 必须拿到 body 字节；mock 可直接给 buffer/getReader
          let buf;
          if (Buffer.isBuffer(resp.body)) buf = resp.body;
          else if (resp.arrayBuffer) buf = Buffer.from(await resp.arrayBuffer());
          else if (resp.body && typeof resp.body.getReader === 'function') {
            const reader = resp.body.getReader();
            const parts = [];
            for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); }
            buf = Buffer.concat(parts);
          } else throw new Error('响应体不可读');
          // 200 且未支持 Range 时会返回整文件，长度不符判失败（避免写入错误数据）
          if (buf.length !== c.length) throw new Error(`分段长度不符: 期望 ${c.length} 实际 ${buf.length}`);
          F.writeFileSync(pp, buf);
          ok = true;
        } catch (e) {
          if (attempt >= retries) failures.push(`chunk ${c.index}: ${e.message}`);
          else if (o.sleepFn) await o.sleepFn(50 * (attempt + 1));
        }
      }
      if (!ok) return; // 该 worker 失败后停止取新任务，避免无谓请求
    }
  };
  const workers = Array.from({ length: Math.min(o.concurrency, chunks.length) }, () => worker());
  await Promise.all(workers);

  if (failures.length) return { ok: false, error: failures.join('; '), resumed, size };

  // 3. 按序合并 + 整体 sha1。合并前再校验每段长度（防止 .part 被外部破坏）
  const merged = `${dest}.part.merged`;
  const hash = crypto.createHash('sha1');
  try {
    const out = F.createWriteStream ? F.createWriteStream(merged, { flags: 'w' }) : null;
    if (out) {
      await new Promise((resolve, reject) => {
        let i = 0;
        const pump = () => {
          if (i >= chunks.length) { out.end(resolve); return; }
          const c = chunks[i];
          const pp = partPath(c);
          const data = F.readFileSync(pp);
          if (data.length !== c.length) { out.end(); reject(new Error(`合并前段 ${c.index} 长度异常`)); return; }
          hash.update(data);
          if (!out.write(data)) out.once('drain', () => { i++; pump(); });
          else { i++; pump(); }
        };
        out.on('error', reject);
        pump();
      });
    } else {
      // 无 createWriteStream（简化 fsImpl）：直接 Buffer.concat
      const parts = chunks.map(c => {
        const data = F.readFileSync(partPath(c));
        if (data.length !== c.length) throw new Error(`合并前段 ${c.index} 长度异常`);
        hash.update(data);
        return data;
      });
      F.writeFileSync(merged, Buffer.concat(parts));
    }
    const sha1 = hash.digest('hex');
    const finalSize = F.statSync(merged).size;
    if (finalSize !== size) throw new Error(`合并大小不符: 期望 ${size} 实际 ${finalSize}`);
    if (o.expectedSha1 && sha1 !== String(o.expectedSha1).toLowerCase()) {
      return { ok: false, error: `SHA1 不符: 期望 ${o.expectedSha1} 实际 ${sha1}`, resumed, size };
    }
    F.renameSync(merged, dest);
    // 4. 清理所有段临时文件（保留成功；清理失败不影响成品）
    for (const c of chunks) { try { F.rmSync(partPath(c)); } catch { /* noop */ } }
    return { ok: true, sha1, size: finalSize, chunks: chunks.length, resumed, downloaded: chunks.length - resumed };
  } catch (e) {
    return { ok: false, error: `合并失败: ${e.message}`, resumed, size };
  }
}

module.exports = {
  DEFAULTS, planChunks, shouldParallel, probe, downloadParallel
};
