'use strict';
/**
 * memoryLeak.test.cjs — 0.9.0 模块二C：渲染层内存泄漏排查 TDD
 *
 * 【排查结论（改前）】4 处订阅缺 cleanup：App.jsx(onGameExit/onServerExit)、
 *  DownloadPage(4 个 download:*)、ConsolePage 桌面分支(onGameLog/onServerLog)、
 *  JavaManagerPage(onJavaProgress)；另有 3 处 setTimeout 无清理、日志缓冲常量散落、
 *  ConsolePage 全量渲染最多 3000 行 DOM。页面反复 mount/unmount 会累积监听器。
 *
 * 【验证方式（诚实边界）】真实 24 小时 heap 曲线需要 Electron 运行时 + 真机观测，
 *  沙盒无 GUI 不伪造内存数字。这里用高频等价事件验证**结构性不变量**：
 *  活跃订阅数、缓冲长度、渲染窗口长度恒有上界且不随时间单调增长。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const MEM_PATH = path.join(ROOT, 'src/lib/memory.mjs');
const load = () => import(pathToFileURL(MEM_PATH).href);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SRC = path.join(ROOT, 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

// ==================== 1. 有界缓冲 ====================

test('BUFFER_LIMITS：所有上限为正整数且渲染窗口 < 日志缓冲', async () => {
  const M = await load();
  for (const [k, v] of Object.entries(M.BUFFER_LIMITS)) {
    assert.ok(Number.isInteger(v) && v > 0, `${k} 应为正整数上限，实际 ${v}`);
  }
  assert.ok(M.BUFFER_LIMITS.RENDER_WINDOW < M.BUFFER_LIMITS.LOG_LINES, 'DOM 渲染窗口必须小于日志缓冲');
  assert.ok(Object.isFrozen(M.BUFFER_LIMITS), '上限常量应冻结，防运行时篡改');
});

test('appendBounded：超上限丢弃最旧、保留最新，输入不可变', async () => {
  const M = await load();
  const src = [1, 2, 3];
  const r = M.appendBounded(src, [4, 5], 4);
  assert.deepEqual(r, [2, 3, 4, 5]);
  assert.deepEqual(src, [1, 2, 3], '不得修改输入数组');
  assert.equal(M.appendBounded(src, 4, 10).length, 4);
  assert.equal(M.appendBounded(src, [], 10), src, '空追加返回原引用，避免无谓重渲染');
});

test('appendBounded：非法 cap 不增长；10 万次高频追加长度恒等于上限', async () => {
  const M = await load();
  const src = [1, 2];
  assert.equal(M.appendBounded(src, 3, 0), src);
  assert.equal(M.appendBounded(src, 3, -1), src);
  assert.equal(M.appendBounded(src, 3, NaN), src);
  let buf = [];
  for (let i = 0; i < 100000; i++) {
    buf = M.appendBounded(buf, `log-${i}`, 60);
    if (i % 20000 === 0) assert.ok(buf.length <= 60);
  }
  assert.equal(buf.length, 60, '高频追加后长度必须稳定在上限，绝不单调增长');
  assert.equal(buf[59], 'log-99999', '应始终保留最新数据');
  assert.equal(buf[0], 'log-99940', '应始终丢弃最旧数据');
});

test('renderWindow：DOM 节点数恒有上界，且取末尾最新窗口', async () => {
  const M = await load();
  const list = Array.from({ length: 3000 }, (_, i) => i);
  const w = M.renderWindow(list, 500);
  assert.equal(w.length, 500);
  assert.equal(w[0], 2500);
  assert.equal(w[499], 2999);
  assert.deepEqual(M.renderWindow(list, 5000), list, '不足上限时原样返回');
  assert.deepEqual(M.renderWindow(list, 0), [], '非法上限返回空，绝不无限渲染');
});

// ==================== 2. 订阅集 / 仪表 / 包装 ====================

test('createSubscriptionSet：收集 off、disposeAll 幂等、单个抛错不阻断其余', async () => {
  const M = await load();
  let n = 0;
  const s = M.createSubscriptionSet();
  s.add(() => { n++; });
  s.add(() => { throw new Error('cancel failed'); });
  s.add(() => { n++; });
  assert.equal(s.size, 3);
  assert.equal(s.disposeAll(), 3);
  assert.equal(n, 2, '抛错的 off 不影响其余订阅清理');
  assert.equal(s.disposed, true);
  assert.equal(s.disposeAll(), 0, '重复 dispose 幂等');
  s.add(() => { n++; });
  assert.equal(s.size, 0, 'dispose 后不再接受新订阅');
});

test('createSubscriptionRegistry：track/release 幂等，peak 与统计自洽，reset 可复测', async () => {
  const M = await load();
  const r = M.createSubscriptionRegistry();
  const a = r.track('onGameLog');
  const b = r.track('onDownloadProgress');
  assert.equal(r.stats().total, 2);
  assert.deepEqual(r.stats().byMethod, { onGameLog: 1, onDownloadProgress: 1 });
  assert.equal(r.stats().peak, 2);
  assert.equal(a(), true);
  assert.equal(a(), false, '重复 release 幂等');
  assert.equal(r.stats().total, 1);
  b();
  const s = r.stats();
  assert.equal(s.total, 0);
  assert.equal(s.created, 2);
  assert.equal(s.disposed, 2);
  assert.equal(s.created - s.disposed, s.total, '计数必须自洽，否则说明有泄漏');
  r.reset();
  assert.equal(r.stats().created, 0);
});

test('wrapSubscription：底层 off 调用一次、异常 off 仍注销仪表、重复调用不重复计数', async () => {
  const M = await load();
  const reg = M.createSubscriptionRegistry();
  let calls = 0;
  const off1 = M.wrapSubscription(() => { calls++; }, 'onGameLog', reg);
  assert.equal(reg.stats().total, 1);
  assert.equal(off1(), true);
  assert.equal(off1(), false);
  assert.equal(calls, 1);
  assert.equal(reg.stats().disposed, 1);

  const off2 = M.wrapSubscription(() => { throw new Error('底层取消失败'); }, 'onServerLog', reg);
  assert.equal(off2(), true, '底层抛错也必须完成仪表注销');
  assert.equal(reg.stats().total, 0);
  assert.equal(reg.stats().disposed, 2);
});

test('全局 subscriptionRegistry 单例：bridge.js 与诊断共用同一实例', async () => {
  const M = await load();
  M.subscriptionRegistry.reset();
  const off = M.wrapSubscription(() => {}, 'onJvmMetrics');
  assert.equal(M.subscriptionRegistry.stats().total, 1);
  off(); off();
  assert.equal(M.subscriptionRegistry.stats().total, 0);
  assert.equal(M.subscriptionRegistry.stats().disposed, 1, '重复 off 不得重复计数');
});

// ==================== 3. 24h 等价挂机压力 ====================

test('24h 等价挂机：2000 次 mount/unmount + 10 万条日志，活跃订阅与缓冲不单调增长', async () => {
  const M = await load();
  const reg = M.createSubscriptionRegistry();
  const CYCLES = 2000;        // 24h 内约每 43 秒切换一次页面
  const SUBS_PER_MOUNT = 4;   // 单页最多订阅数（下载页 4 个事件）
  const LOGS_PER_CYCLE = 50;  // 每轮高频日志
  let buf = [];
  let maxActive = 0;
  for (let c = 0; c < CYCLES; c++) {
    // mount：订阅 4 个底层事件
    const offs = [];
    for (let i = 0; i < SUBS_PER_MOUNT; i++) {
      offs.push(M.wrapSubscription(() => {}, `onDownload${i}`, reg));
    }
    // 高频日志事件
    buf = M.appendBounded(buf, Array.from({ length: LOGS_PER_CYCLE }, (_, i) => `L${c}-${i}`), M.BUFFER_LIMITS.LOG_LINES);
    const rendered = M.renderWindow(buf, M.BUFFER_LIMITS.RENDER_WINDOW);
    assert.ok(buf.length <= M.BUFFER_LIMITS.LOG_LINES, `第 ${c} 轮日志缓冲越界`);
    assert.ok(rendered.length <= M.BUFFER_LIMITS.RENDER_WINDOW, `第 ${c} 轮渲染窗口越界`);
    maxActive = Math.max(maxActive, reg.stats().total);
    // unmount：全部注销
    for (const off of offs) off();
    if (c % 100 === 0) assert.equal(reg.stats().total, 0, `第 ${c} 轮卸载后仍有活跃订阅（泄漏）`);
  }
  const s = reg.stats();
  assert.equal(s.total, 0, '挂机结束不得残留任何订阅');
  assert.equal(s.created, CYCLES * SUBS_PER_MOUNT);
  assert.equal(s.disposed, s.created, '创建数必须等于注销数');
  assert.equal(s.peak, SUBS_PER_MOUNT, '峰值恒等于单次挂载订阅数，不随时间增长');
  assert.equal(maxActive, SUBS_PER_MOUNT);
  assert.equal(buf.length, M.BUFFER_LIMITS.LOG_LINES, '缓冲稳定在上限，不单调增长');
  assert.equal(M.renderWindow(buf, M.BUFFER_LIMITS.RENDER_WINDOW).length, M.BUFFER_LIMITS.RENDER_WINDOW);
});

// ==================== 4. 静态守卫（防回退） ====================

test('静态守卫：src/ 内不存在「裸订阅」——每个事件订阅结果必须被接收以便注销', () => {
  // 行首直接调用 api.onXxx(...) / a.onXxx(...) 且结果被丢弃 = 泄漏（改前 8 处）
  const BARE = /^\s*(api|a)\.on[A-Z]\w*\??\(/m;
  const offenders = [];
  for (const p of walk(SRC)) {
    const s = read(p);
    if (BARE.test(s)) offenders.push(path.relative(ROOT, p));
  }
  assert.deepEqual(offenders, [], `以下文件存在未接收返回值的事件订阅（缺 cleanup）: ${offenders.join(', ')}`);
});

test('静态守卫：所有订阅点都有 disposeAll / off 清理，定时器与监听器成对', () => {
  const files = walk(SRC);
  for (const p of files) {
    const s = read(p);
    if (/\b(on[A-Z]\w*\??\()/.test(s) && /\b(api|a)\.on[A-Z]/.test(s)) {
      assert.ok(/disposeAll\(\)|return \(\) =>/.test(s),
        `${path.relative(ROOT, p)} 含订阅但未见 cleanup`);
    }
    if (s.includes('setInterval(')) {
      assert.ok(s.includes('clearInterval('), `${path.relative(ROOT, p)} 的 setInterval 未清理`);
    }
    if (s.includes('addEventListener(')) {
      assert.ok(s.includes('removeEventListener('), `${path.relative(ROOT, p)} 的 addEventListener 未清理`);
    }
  }
  // 交互触发的延时器必须集中管理并在卸载时清理
  for (const rel of ['src/features/settings/SettingsPage.jsx', 'src/features/shell/components/CrashDialog.jsx']) {
    const s = read(path.join(ROOT, rel));
    assert.ok(s.includes('setTimeout('), `${rel} 应仍有延时提示`);
    assert.ok(s.includes('clearTimeout('), `${rel} 的 setTimeout 未清理（卸载后 setState / 定时器残留）`);
  }
});

test('静态守卫：高频缓冲统一走 BUFFER_LIMITS / appendBounded，日志区使用渲染窗口', () => {
  const console = read(path.join(SRC, 'features/launcher/ConsolePage.jsx'));
  assert.match(console, /appendBounded/, '日志追加必须有界');
  assert.match(console, /renderWindow\(/, '日志区必须使用渲染窗口');
  assert.match(console, /BUFFER_LIMITS/, '上限必须来自单一数据源');
  assert.doesNotMatch(console, /filtered\.map\(/, '不得再全量渲染 filtered（DOM 无上界）');
  assert.match(console, /subs\.disposeAll\(\)/, '桌面分支订阅必须注销');

  for (const rel of [
    'features/launcher/components/PerfRadar.jsx',
    'features/mods/ModpackPage.jsx',
    'features/settings/JavaManagerPage.jsx',
    'features/launcher/DownloadPage.jsx',
    'App.jsx'
  ]) {
    const s = read(path.join(SRC, rel));
    assert.match(s, /BUFFER_LIMITS|appendBounded|createSubscriptionSet/,
      `${rel} 应接入内存守护工具`);
  }
});

test('静态守卫：Service 层订阅仪表接线（subscribe 走 wrapSubscription 且暴露统计）', () => {
  const bridge = read(path.join(SRC, 'services/bridge.js'));
  assert.match(bridge, /wrapSubscription\(off, method\)/, 'subscribe 必须包装订阅以登记仪表');
  assert.match(bridge, /getSubscriptionStats/, '必须暴露订阅统计供挂机诊断');
  const idx = read(path.join(SRC, 'services/index.js'));
  assert.match(idx, /getSubscriptionStats/, '统一出口应再导出订阅统计');
  assert.match(idx, /memory\.mjs/, '统一出口应再导出内存守护工具');
  assert.ok(fs.existsSync(MEM_PATH), 'memory.mjs 必须存在');
});
