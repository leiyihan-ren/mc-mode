/**
 * downloader.cjs — 全能并发下载引擎（PCL2 极速下载 / HMCL 多源并发）
 *
 * 真实能力：
 *  - 有界并发 worker pool（默认 8），避免打爆文件描述符与带宽
 *  - 每任务多源：官方源 / 显式备用源 / BMCLAPI 镜像，失败自动换源（复用 http.js 的降级链）
 *  - SHA-1 完整性校验、.part 断点续传、原子 rename
 *  - 聚合进度（字节/百分比/速度/ETA）、事件流、按任务或全局取消
 *  - 取消经 AbortSignal 穿透到 fetch，不产生僵尸请求
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { downloadFile } = require('./http');

class DownloadQueue {
  /**
   * @param {object} opts {concurrency, retries, fetchImpl, onEvent}
   */
  constructor(opts = {}) {
    this.concurrency = Math.max(1, Number(opts.concurrency) || 8);
    this.retries = opts.retries === undefined ? 2 : opts.retries;
    this.fetchImpl = opts.fetchImpl || null;
    this.onEvent = opts.onEvent || (() => {});
    // —— 0.4.0 模块三：多源加速 + 指数退避配置透传 ——
    // 只收集显式传入的键，避免 undefined 覆盖 http.js 的 DEFAULTS
    this.preferMirror = opts.preferMirror !== false;
    this.backoffOpts = {};
    for (const k of ['backoffBaseMs', 'backoffMaxMs', 'backoffFactor', 'jitter', 'sleepFn', 'random', 'timeoutMs']) {
      if (opts[k] !== undefined) this.backoffOpts[k] = opts[k];
    }
    this.results = [];
    this.controllers = new Map();
    this.cancelled = new Set();
    this.bytes = new Map();
    this.totals = new Map();
    this.counts = { done: 0, error: 0, cancelled: 0, total: 0 };
    this.startedAt = 0;
    this._allCancelled = false;
  }

  _emit(type, payload) {
    try { this.onEvent({ type, at: Date.now(), ...payload }); } catch { /* 事件消费者异常不影响下载 */ }
  }

  /** 把外部取消信号与 http.js 的超时信号合并后注入 fetch */
  _scopedFetch(signal) {
    const base = this.fetchImpl || ((...a) => fetch(...a));
    return (url, init = {}) => {
      if (!signal) return base(url, init);
      let merged;
      if (init.signal && typeof AbortSignal.any === 'function') merged = AbortSignal.any([init.signal, signal]);
      else if (init.signal) {
        const c = new AbortController();
        init.signal.addEventListener('abort', () => c.abort(), { once: true });
        signal.addEventListener('abort', () => c.abort(), { once: true });
        if (signal.aborted || init.signal.aborted) c.abort();
        merged = c.signal;
      } else merged = signal;
      return base(url, { ...init, signal: merged });
    };
  }

  /** 队列整体进度快照 */
  progress() {
    let done = 0, total = 0;
    for (const [id, b] of this.bytes) { done += b; total += this.totals.get(id) || b; }
    const elapsed = Math.max(1, Date.now() - this.startedAt) / 1000;
    const speed = done / elapsed;
    return {
      bytes: done, total, percent: total ? +(done / total * 100).toFixed(1) : 0,
      speed: Math.round(speed), etaSeconds: speed > 0 && total > done ? Math.round((total - done) / speed) : 0,
      counts: { ...this.counts }
    };
  }

  cancel(id) {
    this.cancelled.add(id);
    const c = this.controllers.get(id);
    if (c) c.abort(new Error('cancelled'));
  }
  cancelAll() {
    this._allCancelled = true;
    for (const id of this.controllers.keys()) this.cancel(id);
  }

  async _runOne(task) {
    const id = task.id || task.dest;
    const ac = new AbortController();
    this.controllers.set(id, ac);
    this.totals.set(id, task.size || 0);
    this.bytes.set(id, 0);
    this._emit('start', { id, url: task.url });

    const urls = [...new Set([task.url, ...(task.urls || [])])].filter(Boolean);
    try {
      if (ac.signal.aborted || this._allCancelled) throw new Error('cancelled');
      // 一次调用即可：http.js 内部按 [BMCLAPI 镜像, 显式备用源, Mojang 官方] 顺序自动降级
      // （preferMirror:false 时退回 [原 URL, 备用源, 镜像] 旧顺序）
      const r = await downloadFile(urls[0], task.dest, {
        fetchImpl: this._scopedFetch(ac.signal),
        signal: ac.signal,
        extraUrls: urls.slice(1),
        expectedSha1: task.sha1 || null,
        totalBytesHint: task.size || 0,
        retries: this.retries,
        mirrorRetries: 0,
        preferMirror: this.preferMirror,
        ...this.backoffOpts,
        onRetry: (info) => this._emit('retry', { id, ...info }),
        onProgress: (received, totalBytes) => {
          this.bytes.set(id, received);
          if (totalBytes) this.totals.set(id, totalBytes);
          this._emit('progress', { id, bytes: received, total: totalBytes, ...this.progress() });
        }
      });
      this.counts.done++;
      const result = { id, ok: true, dest: task.dest, sha1: r.sha1, size: r.size, usedUrl: r.usedUrl, task };
      this.results.push(result);
      this._emit('done', { id, ...result });
      return result;
    } catch (e) {
      if (ac.signal.aborted || this.cancelled.has(id)) {
        this.counts.cancelled++;
        const r = { id, ok: false, cancelled: true, error: 'cancelled' };
        this.results.push(r);
        this._emit('cancelled', { id });
        return r;
      }
      this.counts.error++;
      const r = { id, ok: false, error: String(e.message || e), task };
      this.results.push(r);
      this._emit('error', { id, error: r.error });
      return r;
    } finally {
      this.controllers.delete(id);
    }
  }

  /**
   * 批量入队并等待完成。
   * @param {Array} tasks [{id,url,urls?,dest,sha1?,size?}]
   * @returns {Promise<{results:Array, progress:object}>}
   */
  async enqueue(tasks) {
    const list = (Array.isArray(tasks) ? tasks : [tasks]).map(t => {
      if (!t.url || !t.dest) throw new Error('下载任务必须包含 url 与 dest');
      fs.mkdirSync(path.dirname(t.dest), { recursive: true });
      return t;
    });
    this.counts.total += list.length;
    this.startedAt = this.startedAt || Date.now();
    for (const t of list) this._emit('queued', { id: t.id || t.dest });

    const pending = list.slice();
    const workers = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      for (;;) {
        const t = pending.shift();
        if (!t || this._allCancelled) break;
        await this._runOne(t);
      }
    });
    await Promise.all(workers);
    const summary = this.progress();
    this._emit('summary', summary);
    return { results: this.results, progress: summary };
  }
}

/** 便捷函数：一次性并发下载 */
async function downloadBatch(tasks, opts = {}) {
  const q = new DownloadQueue(opts);
  return q.enqueue(tasks);
}

module.exports = { DownloadQueue, downloadBatch };
