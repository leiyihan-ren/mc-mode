'use strict';
/** 【0.6.0 模块三】JVM 监控与一键调优：GC 日志解析 / RSS 探针 / 参数生成断言 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const M = require('../engine/jvm/monitor.cjs');
const appearance = require('../engine/appearance.cjs');

const JDK9_GC = '[0.423s][info][gc] GC(3) Pause Young (G1 Evacuation Pause) 256M->64M(4096M) 12.345ms';
const JDK9_FULL = '[12.001s][info][gc] GC(42) Pause Full (System.gc()) 2048M->512M(4096M) 234.5ms';
const JDK8_GC = '[GC (Allocation Failure)  65536K->8192K(251392K), 0.0123456 secs]';
const NOT_GC = '[12:00:01] [Server thread/INFO]: Preparing spawn area: 42%';

// ==================== GC 日志解析 ====================
test('parseSizeMb 真实换算 K/M/G', () => {
  assert.equal(M.parseSizeMb('1024K'), 1);
  assert.equal(M.parseSizeMb('256M'), 256);
  assert.equal(M.parseSizeMb('2G'), 2048);
  assert.equal(M.parseSizeMb('garbage'), null);
});

test('解析 JDK9+ 统一 GC 日志（-Xlog:gc*）的堆与暂停', () => {
  const g = M.parseGcLogLine(JDK9_GC);
  assert.ok(g);
  assert.equal(g.gcId, 3);
  assert.equal(g.kind, 'young');
  assert.equal(g.heapBeforeMb, 256);
  assert.equal(g.heapAfterMb, 64);
  assert.equal(g.heapMaxMb, 4096);
  assert.equal(g.pauseMs, 12.345);
  assert.match(g.cause, /G1 Evacuation Pause/);
});

test('解析 Full GC 与 JDK8 -verbose:gc 的 secs 单位', () => {
  const full = M.parseGcLogLine(JDK9_FULL);
  assert.equal(full.kind, 'full');
  assert.equal(full.pauseMs, 234.5);
  const old = M.parseGcLogLine(JDK8_GC);
  assert.ok(old);
  assert.equal(old.kind, 'young');
  assert.equal(old.heapBeforeMb, 64);       // 65536K
  assert.equal(old.heapAfterMb, 8);         // 8192K
  assert.equal(old.heapMaxMb, 245.5);       // 251392K
  assert.equal(old.pauseMs, 12.346);        // 0.0123456 secs → 12.346ms
});

test('非 GC 行返回 null，不把普通日志误判成 GC', () => {
  assert.equal(M.parseGcLogLine(NOT_GC), null);
  assert.equal(M.parseGcLogLine(''), null);
  assert.equal(M.parseGcLogLine('[info][gc] GC(0) Concurrent Mark Cycle'), null);
});

test('gcArgsForMcVersion：1.17+ 用 JDK9 统一日志，旧版用 verbose:gc', () => {
  assert.deepEqual(M.gcArgsForMcVersion('1.21.1'), ['-Xlog:gc*:stdout']);
  assert.deepEqual(M.gcArgsForMcVersion('1.17'), ['-Xlog:gc*:stdout']);
  assert.ok(M.gcArgsForMcVersion('1.16.5').includes('-verbose:gc'));
  assert.ok(M.gcArgsForMcVersion('1.12.2').includes('-XX:+PrintGCDetails'));
});

// ==================== 一键调优参数生成（模块六要求的核心断言） ====================
const GB = 1024 * 1024 * 1024;

test('一键调优：按物理内存分档，Xmx 随内存单调不减且不超过 16G', () => {
  const a = M.recommendJvm(4 * GB);
  const b = M.recommendJvm(8 * GB);
  const c = M.recommendJvm(32 * GB);
  const mb = s => Number(String(s).replace('M', ''));
  assert.ok(mb(a.maxMemory) >= 1024 && mb(a.maxMemory) <= 4096 * 0.4);
  assert.ok(mb(b.maxMemory) > mb(a.maxMemory));
  assert.equal(mb(c.maxMemory), 16384, '32G 机器按 50% 应命中 16G 上限');
  assert.equal(a.totalMemMb, 4096);
  assert.equal(c.totalMemMb, 32768);
});

test('一键调优：小内存守住下限，参数真实可用且不含内存项（由界面托管）', () => {
  const r = M.recommendJvm(512 * 1024 * 1024);
  assert.equal(r.ok, true);
  assert.equal(r.minMemory, '1024M');
  assert.ok(r.args.includes('-XX:+UseG1GC'));
  assert.ok(r.args.length >= 10, `G1 参数过少: ${r.args.length}`);
  assert.equal(r.args.some(x => /^-Xmx|^-Xms/.test(x)), false, '内存必须由界面托管');
  assert.equal(r.issues.filter(i => i.severity === 'error').length, 0);
  assert.equal(appearance.validateJvmArgs(r.args).ok, true);
  assert.equal(appearance.parseJvmArgs(r.argsText).length, r.args.length);
});

test('一键调优：大内存命中 large 预设并追加 G1HeapRegionSize', () => {
  const r = M.recommendJvm(64 * GB);
  assert.equal(r.profileId, 'large');
  assert.ok(r.args.includes('-XX:G1HeapRegionSize=16M'));
  assert.ok(r.notes.some(n => n.includes('物理内存')));
});

test('一键调优：可要求 Xms 为 Xmx 一半', () => {
  const r = M.recommendJvm(16 * GB, { sameXms: false });
  const xmx = Number(r.maxMemory.replace('M', ''));
  const xms = Number(r.minMemory.replace('M', ''));
  assert.equal(xms, Math.floor(xmx / 2 / 256) * 256);
});

// ==================== /proc RSS 真实探针 ====================
test('readRssKb 读取真实 /proc/self/status 的 VmRSS，非 Linux 明确返回 null', () => {
  if (process.platform === 'linux') {
    assert.ok(M.readRssKb(process.pid) > 0, '当前进程 RSS 必须为正数');
  }
  assert.equal(M.readRssKb(process.pid, 'win32'), null);
  assert.equal(M.readRssKb(999999999), null);
  assert.equal(M.readRssKb(null), null);
});

// ==================== 监控器状态机 ====================
test('JvmMonitor 汇总真实 GC 事件：次数 / 累计暂停 / 最长暂停', () => {
  const m = new M.JvmMonitor({ now: () => 1000, readRss: () => 0, pid: 1 });
  assert.equal(m.ingestLine(NOT_GC), null);
  m.ingestLine(JDK9_GC);
  m.ingestLine(JDK9_FULL);
  assert.equal(m.gc.count, 2);
  assert.equal(m.gc.maxPauseMs, 234.5);
  assert.equal(Math.round(m.gc.totalPauseMs * 1000) / 1000, 246.845);
  const s = m.sample();
  assert.equal(s.heapAfterMb, 512);
  assert.equal(s.heapMaxMb, 4096);
  assert.equal(s.rssMb, 0);
  assert.equal(s.gcCount, 2);
});

test('JvmMonitor 样本环形缓冲不无限增长', () => {
  const m = new M.JvmMonitor({ maxSamples: 5, now: () => 1, readRss: () => 1024, pid: 1 });
  for (let i = 0; i < 20; i++) m.sample();
  assert.equal(m.samples.length, 5);
  assert.equal(m.summary().sampleCount, 5);
  assert.equal(m.samples[0].rssMb, 1);
});

test('attach 到真实 EventEmitter 的 log/exit，stop 后监听被移除', () => {
  const launcher = new EventEmitter();
  launcher.process = { pid: 4242 };
  launcher.running = true;
  const m = new M.JvmMonitor({ intervalMs: 100000, readRss: () => 2048 });
  m.attach(launcher);
  assert.equal(m.pid, 4242);
  launcher.emit('log', { level: 'info', text: JDK9_GC });
  assert.equal(m.gc.count, 1);
  assert.equal(m.samples.length, 1, 'attach 时立即采样一次');
  launcher.emit('exit', { code: 0 });
  assert.equal(launcher.listenerCount('log'), 0);
  assert.equal(launcher.listenerCount('exit'), 0);
  assert.equal(m.summary().running, false);
});
