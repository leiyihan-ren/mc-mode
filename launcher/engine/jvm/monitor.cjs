'use strict';
/**
 * monitor.cjs — 0.6.0 模块三：JVM 底层监控与性能调优（纯逻辑 + 真实进程探针）
 *
 * 1) 真实监听：GameLauncher 已经把子进程 stdout/stderr 以 'log' 事件吐出；
 *    本模块的 JvmMonitor 挂上去，逐行解析 JVM GC 日志，不重开进程、不伪造数据。
 * 2) 内存探针：Linux 读 /proc/<pid>/status 的 VmRSS（真实内核数据，等价于 psutil 的 rss）；
 *    非 Linux 明确返回 null，UI 显示「不可用」而不是编造数值。
 * 3) 一键调优：按物理内存分档生成 Xmx/Xms + 复用 0.5.0 的 G1_BASE 预设（单一数据源），
 *    经 appearance.mergeLaunchJvm 去重/校验后可直接写入启动指令。
 * 4) GC 日志参数：按 MC 版本选择 JDK9+ 统一日志或 JDK8 verbose:gc，保证「有日志可解析」。
 */
const fs = require('fs');
const { EventEmitter } = require('events');
const appearance = require('../appearance.cjs');

const MAX_SAMPLES = 180;

/**
 * @typedef {Object} GcEvent 一行真实 GC 日志解析结果
 * @property {number|null} gcId GC 序号（JDK9+ GC(n)）
 * @property {'full'|'young'|'mixed'|null} kind GC 类型
 * @property {string|null} cause 触发原因（Allocation Failure / G1 Evacuation Pause …）
 * @property {number} heapBeforeMb GC 前堆占用 (MB)
 * @property {number} heapAfterMb GC 后堆占用 (MB)
 * @property {number} heapMaxMb 堆上限 (MB)
 * @property {number} pauseMs 停顿时长 (ms)
 * @property {string} raw 原始日志行
 */

/**
 * @typedef {Object} JvmSample 一次定时采样
 * @property {number} t 时间戳 (ms)
 * @property {number|null} rssMb 进程常驻内存 (MB)；非 Linux 无 /proc 时为 null（不伪造）
 * @property {number|null} heapAfterMb 最近一次 GC 后堆占用
 * @property {number|null} heapMaxMb 堆上限
 * @property {number} gcCount 累计 GC 次数
 * @property {number|null} gcPauseMs 最近一次 GC 停顿
 * @property {boolean} running 游戏进程是否仍在运行
 */

/**
 * @typedef {Object} JvmRecommend 一键调优结果
 * @property {boolean} ok 生成参数是否通过校验（无 error 级 issue）
 * @property {number} totalMemMb 物理内存 (MB)
 * @property {string} minMemory -Xms 值（如 "4096M"）
 * @property {string} maxMemory -Xmx 值
 * @property {string} profileId 采用的 G1GC 预设 id
 * @property {string[]} args 完整 JVM 参数数组（可直接写入启动指令）
 * @property {string} argsText 参数文本（换行分隔）
 * @property {Array<{severity:string}>} issues 校验问题列表
 * @property {number} ratio 分配比例
 * @property {string[]} notes 人类可读说明
 */

/** 把 24M / 65536K / 2G 解析成 MB
 * @param {string} s 带单位的大小字符串
 * @returns {number|null} MB 数值；非法输入返回 null
 */
function parseSizeMb(s) {
  const m = /^(\d+(?:\.\d+)?)([KMGkmg])?B?$/.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || 'M').toUpperCase();
  if (u === 'K') return n / 1024;
  if (u === 'G') return n * 1024;
  return n;
}

/**
 * 解析一行真实 JVM GC 日志，覆盖两种主流格式：
 *  JDK9+  (-Xlog:gc*): [0.123s][info][gc] GC(0) Pause Young (G1 Evacuation Pause) 24M->8M(256M) 3.456ms
 *  JDK8   (-verbose:gc): [GC (Allocation Failure)  65536K->8192K(251392K), 0.0123456 secs]
 * 非 GC 行返回 null（不伪造数据）。
 * @param {string} raw 单行日志
 * @returns {GcEvent|null} 解析结果，非 GC 行为 null
 */
function parseGcLogLine(raw) {
  const line = String(raw || '');
  if (!/(?:\bGC\b|gc)/.test(line)) return null;
  const heap = /(\d+(?:\.\d+)?[KMGkmg])->(\d+(?:\.\d+)?[KMGkmg])\((\d+(?:\.\d+)?[KMGkmg])\)/.exec(line);
  if (!heap) return null;
  const before = parseSizeMb(heap[1]);
  const after = parseSizeMb(heap[2]);
  const max = parseSizeMb(heap[3]);
  if (before == null || after == null || max == null) return null;

  const ms = /([\d.]+)\s*ms\b/.exec(line);
  const sec = /([\d.]+)\s*secs?\b/.exec(line);
  const pauseMs = ms ? Number(ms[1]) : (sec ? Number(sec[1]) * 1000 : 0);

  const idM = /\bGC\((\d+)\)/.exec(line);
  const kind = /\bPause Full\b|\bFull GC\b/i.test(line) ? 'full'
    : /\bPause Young\b|\bGC \(|\b\[GC\b/i.test(line) ? 'young'
      : /\bPause Mixed\b/i.test(line) ? 'mixed' : null;
  const causeM = /\(([^)]*)\)/.exec(line.replace(/\bGC\(\d+\)/, ''));

  return {
    gcId: idM ? Number(idM[1]) : null,
    kind,
    cause: causeM ? causeM[1] : null,
    heapBeforeMb: Math.round(before * 10) / 10,
    heapAfterMb: Math.round(after * 10) / 10,
    heapMaxMb: Math.round(max * 10) / 10,
    pauseMs: Math.round(pauseMs * 1000) / 1000,
    raw: line
  };
}

/** MC 1.17+ 需要 Java 16+（可用 -Xlog），旧版常见 Java 8（用 -verbose:gc） */
function gcArgsForMcVersion(versionId) {
  const parts = String(versionId || '').split('.').map(Number);
  const minor = parts[0] === 1 ? (parts[1] || 0) : (parts[0] || 0);
  return minor >= 17
    ? ['-Xlog:gc*:stdout']
    : ['-verbose:gc', '-XX:+PrintGCDetails', '-XX:+PrintGCDateStamps'];
}

/**
 * 根据物理内存生成「极客一键调优」参数。
 * 分配策略：≤4G 取 35%、≤8G 取 45%、更大取 50%，按 256MB 对齐，下限 1G，上限 16G。
 * 参数复用 appearance.G1_BASE（Aikar 系 G1GC），大内存追加 G1HeapRegionSize。
 * @param {number} totalMemBytes 物理内存字节数（os.totalmem()）
 * @param {{maxCapMb?:number, sameXms?:boolean}} [opts] 上限与 Xms 策略
 * @returns {JvmRecommend} 可直接写入启动指令的调优结果
 */
function recommendJvm(totalMemBytes, opts = {}) {
  const totalMb = Math.max(512, Math.floor(Number(totalMemBytes) / 1048576));
  const ratio = totalMb <= 4096 ? 0.35 : totalMb <= 8192 ? 0.45 : 0.5;
  const capMb = opts.maxCapMb || 16384;
  let xmxMb = Math.floor(totalMb * ratio / 256) * 256;
  xmxMb = Math.max(1024, Math.min(capMb, xmxMb));
  const xmsMb = opts.sameXms === false
    ? Math.max(512, Math.floor(xmxMb / 2 / 256) * 256)
    : xmxMb;

  const profileId = xmxMb >= 8192 ? 'large' : 'g1';
  const merged = appearance.mergeLaunchJvm({
    profileId,
    minMemory: `${xmsMb}M`,
    maxMemory: `${xmxMb}M`,
    extraJvmArgsText: ''
  });

  const notes = [
    `检测到物理内存 ${totalMb}MB，按 ${Math.round(ratio * 100)}% 分配给 JVM（为系统/其它进程保留 ${totalMb - xmxMb}MB）`,
    `Xmx=${xmxMb}M / Xms=${xmsMb}M（256MB 对齐，上限 ${capMb}MB）`,
    `采用 ${profileId === 'large' ? '大内存' : '均衡'} G1GC 预设，共 ${merged.jvmArgs.length} 个参数`,
    'GC 日志参数由启动器按 MC 版本自动注入，性能小雷达才有真实数据可解析'
  ];
  if (totalMb <= 4096) notes.push('低物理内存：建议关闭浏览器等后台程序，Xmx 已保守设置');

  return {
    ok: merged.issues.every(i => i.severity !== 'error'),
    totalMemMb: totalMb,
    minMemory: `${xmsMb}M`,
    maxMemory: `${xmxMb}M`,
    profileId,
    args: merged.jvmArgs,
    argsText: merged.jvmArgs.join('\n'),
    issues: merged.issues,
    ratio,
    notes
  };
}

/**
 * 真实读取 Linux 进程常驻内存（VmRSS，kB）；非 Linux 明确返回 null（不编造数值）。
 * @param {number} pid 进程 id
 * @param {string} [platform] 平台（可注入，便于单测）
 * @returns {number|null} VmRSS (kB)，不可用时 null
 */
function readRssKb(pid, platform = process.platform) {
  if (!pid || platform !== 'linux') return null;
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(s);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

class JvmMonitor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.maxSamples = opts.maxSamples || MAX_SAMPLES;
    this.intervalMs = opts.intervalMs || 1000;
    this.platform = opts.platform || process.platform;
    this.readRss = opts.readRss || ((pid) => readRssKb(pid, this.platform));
    this.now = opts.now || (() => Date.now());
    this.pid = opts.pid || null;
    this.samples = [];
    this.gc = { count: 0, totalPauseMs: 0, maxPauseMs: 0, last: null };
    this.startedAt = this.now();
    this.timer = null;
    this.launcher = null;
  }

  /** 挂到 GameLauncher 的 log / exit 事件上（真实 stdout+stderr 流） */
  attach(launcher) {
    this.launcher = launcher;
    if (launcher && launcher.process && launcher.process.pid) this.pid = launcher.process.pid;
    this._onLog = (l) => this.ingestLine(typeof l === 'string' ? l : (l && l.text) || '');
    this._onExit = () => this.stop();
    launcher.on('log', this._onLog);
    launcher.on('exit', this._onExit);
    this.start();
    return this;
  }

  ingestLine(line) {
    const gc = parseGcLogLine(line);
    if (!gc) return null;
    this.gc.count++;
    this.gc.totalPauseMs += gc.pauseMs;
    this.gc.maxPauseMs = Math.max(this.gc.maxPauseMs, gc.pauseMs);
    this.gc.last = gc;
    this.emit('gc', gc);
    return gc;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.sample();
  }

  sample() {
    const rssKb = this.pid ? this.readRss(this.pid) : null;
    const last = this.gc.last;
    const s = {
      t: this.now(),
      rssMb: rssKb == null ? null : Math.round(rssKb / 1024 * 10) / 10,
      heapAfterMb: last ? last.heapAfterMb : null,
      heapMaxMb: last ? last.heapMaxMb : null,
      gcCount: this.gc.count,
      gcPauseMs: last ? last.pauseMs : null,
      running: !!(this.launcher && this.launcher.running)
    };
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.emit('sample', s);
    return s;
  }

  summary() {
    return {
      pid: this.pid,
      platform: this.platform,
      startedAt: this.startedAt,
      sampleCount: this.samples.length,
      samples: this.samples.slice(),
      gc: { ...this.gc },
      running: !!(this.timer)
    };
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.launcher) {
      if (this._onLog) this.launcher.removeListener('log', this._onLog);
      if (this._onExit) this.launcher.removeListener('exit', this._onExit);
    }
    this.emit('stopped');
  }
}

module.exports = {
  MAX_SAMPLES, parseSizeMb, parseGcLogLine, gcArgsForMcVersion,
  recommendJvm, readRssKb, JvmMonitor
};
