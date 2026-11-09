/**
 * guardian.test.cjs — 0.7.0 模块四：崩溃守护 + 僵尸进程清理 TDD
 * 纯逻辑 + 可注入 IO，不依赖真实 Java / 公网。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const G = require('../engine/crash/guardian.cjs');
const R = require('../engine/crash/reaper.cjs');
const { GameLauncher } = require('../engine/launcher');

// ==================== 崩溃守护：实时拦截 ====================

test('STRONG 规则：stderr 出现 OutOfMemoryError 立即上报，报告人类可读', () => {
  const g = new G.CrashGuardian({ now: () => 1700000000000 });
  const reports = [];
  g.on('fatal', r => reports.push(r));
  const r = g.ingest('Exception in thread "Server thread" java.lang.OutOfMemoryError: Java heap space', 'stderr');
  assert.equal(reports.length, 1);
  assert.ok(r);
  assert.equal(r.code, 'OOM');
  assert.equal(r.severity, 'fatal');
  assert.match(r.title, /堆内存溢出/);
  assert.match(r.human, /堆内存溢出/);
  assert.ok(r.suggestions.length > 0, '必须给出可操作建议');
  assert.match(r.suggestions[0], /Xmx/);
  assert.equal(r.stream, 'stderr');
  assert.equal(r.source, 'stream');
  assert.equal(r.at, 1700000000000);
  assert.ok(r.evidence.some(e => e.includes('[stderr]')), '证据需带流来源');
});

test('JVM 原生层崩溃：hs_err / SIGSEGV / Problematic frame 命中 NATIVE_CRASH', () => {
  for (const line of [
    '# A fatal error has been detected by the Java Runtime Environment:',
    '#  SIGSEGV (0xb) at pc=0x00007f, pid=123, tid=456',
    '# Problematic frame: C  [libgl4es.so+0x1234]'
  ]) {
    const g = new G.CrashGuardian();
    const reports = [];
    g.on('fatal', r => reports.push(r));
    g.ingest(line, 'stderr');
    assert.equal(reports.length, 1, `应命中: ${line}`);
    assert.equal(reports[0].code, 'NATIVE_CRASH');
    assert.ok(reports[0].suggestions.some(s => /渲染后端|natives/.test(s)));
  }
});

test('JVM 启动失败 / 栈溢出 / UnsatisfiedLinkError 均属 STRONG', () => {
  const cases = [
    ['Error: Could not find or load main class net.minecraft.client.main.Main', 'JVM_BOOT'],
    ['java.lang.StackOverflowError', 'STACK_OVERFLOW'],
    ['java.lang.UnsatisfiedLinkError: no lwjgl in java.library.path', 'UNSATISFIED_LINK']
  ];
  for (const [line, code] of cases) {
    const g = new G.CrashGuardian();
    const reports = [];
    g.on('fatal', r => reports.push(r));
    g.ingest(line, 'stderr');
    assert.equal(reports[0] && reports[0].code, code, `应命中 ${code}: ${line}`);
  }
});

// ==================== 防误杀：上下文型规则 ====================

test('防误杀：孤立的 ClassNotFoundException（被 catch 的 WARN）不弹窗、不接管', () => {
  const g = new G.CrashGuardian();
  const reports = [];
  g.on('fatal', r => reports.push(r));
  const r = g.ingest('[WARN] ClassNotFoundException caught while probing optional mod', 'stderr');
  assert.equal(r, null);
  assert.equal(reports.length, 0, '无崩溃锚点不得误报');
  assert.equal(g.summary().pending, 1, '应暂存待确认');
});

test('上下文确认：ClassNotFoundException 后紧跟崩溃锚点 → 补报 MISSING_LIB', () => {
  const g = new G.CrashGuardian();
  const reports = [];
  g.on('fatal', r => reports.push(r));
  g.ingest('java.lang.ClassNotFoundException: net.fabricmc.loader.launch', 'stderr');
  assert.equal(reports.length, 0);
  g.ingest('Exception in thread "main"', 'stderr'); // 锚点：确认崩溃
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'MISSING_LIB');
  assert.match(reports[0].title, /缺少依赖库/);
});

test('上下文确认：崩溃报告头 + 描述可确认 GL 渲染失败', () => {
  const g = new G.CrashGuardian();
  const reports = [];
  g.on('fatal', r => reports.push(r));
  g.ingest('GLFW error 65543: GLX: Failed to create context', 'stderr');
  g.ingest('---- Minecraft Crash Report ----', 'stderr');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'GL_RENDER');
});

test('防误杀：JAVA_VERSION 的 "requires Java 17" 正常日志不直接接管', () => {
  const g = new G.CrashGuardian();
  const reports = [];
  g.on('fatal', r => reports.push(r));
  const r = g.ingest('[INFO] Mod xyz requires Java 17 or newer', 'stdout');
  assert.equal(r, null);
  assert.equal(reports.length, 0);
});

test('去重：同一 code 反复出现只上报一次，避免弹窗风暴', () => {
  const g = new G.CrashGuardian();
  let n = 0;
  g.on('fatal', () => n++);
  for (let i = 0; i < 20; i++) g.ingest(`java.lang.OutOfMemoryError: Java heap space #${i}`, 'stderr');
  assert.equal(n, 1);
  assert.equal(g.summary().fatalCount, 1);
});

test('普通日志不触发任何上报', () => {
  const g = new G.CrashGuardian();
  let n = 0;
  g.on('fatal', () => n++);
  for (const l of ['[INFO] Preparing spawn area: 12%', '[INFO] Loaded 1024 recipes', '[WARN] Missing sound: step']) g.ingest(l, 'stdout');
  assert.equal(n, 0);
});

// ==================== 异常退出兜底（绝不静默卡死） ====================

test('finish：未识别特征但异常退出 → UNKNOWN_EXIT 兜底报告', () => {
  const g = new G.CrashGuardian();
  const reports = [];
  g.on('fatal', r => reports.push(r));
  g.ingest('[INFO] Stopping server', 'stdout');
  const r = g.finish({ code: 1 });
  assert.equal(reports.length, 1);
  assert.equal(r.code, 'UNKNOWN_EXIT');
  assert.equal(r.source, 'exit');
  assert.equal(r.exitCode, 1);
  assert.match(r.human, /异常退出/);
});

test('finish：SIGSEGV / 137 / 139 等致命退出码由 analyzer 规则兜底', () => {
  for (const code of [134, 137, 139]) {
    const g = new G.CrashGuardian();
    const reports = [];
    g.on('fatal', r => reports.push(r));
    g.finish({ code });
    assert.equal(reports.length, 1, `exit ${code} 必须兜底上报`);
    assert.equal(reports[0].severity, 'fatal');
  }
});

test('finish：正常退出 / 主动停止 / 已上报，均不重复弹窗', () => {
  const a = new G.CrashGuardian(); let n1 = 0; a.on('fatal', () => n1++);
  a.finish({ code: 0 }); assert.equal(n1, 0, '正常退出不弹窗');

  const b = new G.CrashGuardian(); let n2 = 0; b.on('fatal', () => n2++);
  b.markIntentional(); b.finish({ code: null, signal: 'SIGTERM' }); assert.equal(n2, 0, '主动停止不弹窗');

  const c = new G.CrashGuardian(); let n3 = 0; c.on('fatal', () => n3++);
  c.ingest('java.lang.OutOfMemoryError', 'stderr');
  c.finish({ code: 1 }); assert.equal(n3, 1, '已流式上报不重复');
});

test('finish 幂等：重复调用只产生一次报告；finish 后 ingest 不再上报', () => {
  const g = new G.CrashGuardian();
  let n = 0; g.on('fatal', () => n++);
  g.finish({ code: 1 });
  g.finish({ code: 1 });
  g.ingest('java.lang.OutOfMemoryError', 'stderr');
  assert.equal(n, 1);
  assert.equal(g.summary().finished, true);
});

test('attach/detach：监听 launcher 的 log 事件并透传 stream', () => {
  const { EventEmitter } = require('events');
  const launcher = new EventEmitter();
  const g = new G.CrashGuardian();
  const reports = []; g.on('fatal', r => reports.push(r));
  const detach = g.attach(launcher);
  launcher.emit('log', { level: 'error', text: 'java.lang.OutOfMemoryError: Java heap space', stream: 'stderr' });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stream, 'stderr');
  detach();
  const g2 = new G.CrashGuardian(); // 独立实例验证 detach 生效
  assert.equal(launcher.listenerCount('log'), 0);
});

// ==================== 进程树回收 ====================

test('spawnOptions：POSIX detached=true（进程组回收前提），Windows=false', () => {
  assert.equal(R.spawnOptions({ cwd: '/x' }, 'linux').detached, true);
  assert.equal(R.spawnOptions({}, 'darwin').detached, true);
  assert.equal(R.spawnOptions({}, 'win32').detached, false);
  assert.equal(R.spawnOptions({ cwd: '/x' }, 'linux').cwd, '/x', '保留原选项');
});

test('isAlive：kill(pid,0) 成功=存活；ESRCH=已消失；EPERM=存在但无权限', () => {
  assert.equal(R.isAlive(0, () => {}), false, '非法 pid');
  assert.equal(R.isAlive(42, () => {}), true);
  assert.equal(R.isAlive(42, () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }), false);
  assert.equal(R.isAlive(42, () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; }), true);
});

test('killTree：POSIX 用负 pid 杀整个进程组（连带 Java 子进程）', () => {
  const calls = [];
  const r = R.killTree({ pid: 4242, platform: 'linux', killFn: (p, s) => calls.push([p, s]) });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'process-group(-4242, SIGTERM)');
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('killTree：进程组不可用时降级到单进程，如实标注 method 与降级原因', () => {
  const calls = [];
  const r = R.killTree({
    pid: 4242, platform: 'linux',
    killFn: (p) => { if (p < 0) { const e = new Error('no group'); e.code = 'ESRCH'; throw e; } calls.push(p); }
  });
  assert.equal(r.ok, true);
  assert.match(r.method, /single-process/);
  assert.match(r.error, /降级/);
  assert.deepEqual(calls, [4242]);
});

test('killTree：Windows 用 taskkill /T 递归终止，SIGKILL 追加 /F', () => {
  const calls = [];
  const r = R.killTree({
    pid: 999, platform: 'win32', signal: 'SIGKILL',
    execFileFn: (cmd, args) => calls.push([cmd, args])
  });
  assert.equal(r.ok, true);
  assert.match(r.method, /taskkill/);
  assert.deepEqual(calls[0][1], ['/PID', '999', '/T', '/F']);
});

test('killTree：无 pid 明确拒绝，绝不谎报清理成功', () => {
  const r = R.killTree({ platform: 'linux', killFn: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.pid, null);
  assert.match(r.error, /拒绝/);
});

test('reapAll：登记表中仍存活的进程全部被 killTree，已消失的自动注销', () => {
  const reg = new R.ProcessRegistry();
  reg.track(101, 'java'); reg.track(102, 'java'); reg.track(103, 'launcher');
  const killed = [];
  const out = R.reapAll(reg, {
    platform: 'linux',
    isAlive: (pid) => pid !== 102, // 102 已自行退出
    killFn: (p) => killed.push(p)
  });
  assert.equal(out.scanned, 3);
  assert.equal(out.alive, 2);
  assert.equal(out.killed, 2);
  assert.deepEqual(killed, [-101, -103]);
  assert.equal(reg.size, 0, '清理后登记表必须清空，不留悬挂记录');
});

test('ProcessRegistry：非法 pid 拒绝登记，track/untrack/list 正常', () => {
  const reg = new R.ProcessRegistry();
  assert.equal(reg.track(0), null);
  assert.equal(reg.track(-1), null);
  assert.equal(reg.track(NaN), null);
  reg.track(7, 'java'); reg.track(8, 'server');
  assert.equal(reg.size, 2);
  assert.equal(reg.list()[0].kind, 'java');
  reg.untrack(7);
  assert.equal(reg.size, 1);
});

// ==================== 真实 bug 修复：spawn 失败必须离开「启动中」 ====================

test('GameLauncher：spawn 失败(ENOENT) 仍 emit exit，且带 spawnFailed 标记', async () => {
  const gl = new GameLauncher({
    versionJson: { mainClass: 'x', libraries: [] },
    classpath: '', gameDir: os.tmpdir(),
    nativesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-guard-')),
    javaPath: '/definitely/not/exist/java-binary-070',
    versionId: 'test'
  });
  const exitP = new Promise(resolve => gl.on('exit', resolve));
  const errP = new Promise(resolve => gl.on('error', resolve));
  gl.launch();
  const r = await exitP;
  assert.equal(r.spawnFailed, true);
  assert.equal(r.code, -1);
  assert.match(r.error, /ENOENT|spawn/i);
  assert.equal(gl.running, false, '失败后不得停在 running');
});

test('GameLauncher：真实 java -version 的日志携带 stream 来源', async () => {
  const gl = new GameLauncher({
    versionJson: { mainClass: '-version', libraries: [] },
    classpath: '', gameDir: os.tmpdir(),
    nativesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-guard-')),
    javaPath: 'java', versionId: 'test'
  });
  gl.opts.versionJson.mainClass = '-version';
  const streams = new Set();
  gl.on('log', l => streams.add(l.stream));
  const exitP = new Promise(resolve => gl.on('exit', resolve));
  gl.launch();
  await exitP;
  assert.ok(streams.has('stderr') || streams.has('stdout'), '日志事件必须带 stream 字段');
});
