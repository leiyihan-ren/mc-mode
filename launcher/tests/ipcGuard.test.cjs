/**
 * ipcGuard.test.cjs — 0.9.0 模块一C：IPC / JNI 通信全局异常拦截 TDD（纯离线）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../engine/crash/ipcGuard.cjs');

test('isFatalError：原生层信号 / hs_err / UnsatisfiedLink / JNI 判定为 fatal', () => {
  const cases = [
    new Error('SIGSEGV (0xb) at pc=0x0000, pid=1'),
    new Error('A fatal error has been detected by the Java Runtime Environment'),
    new Error('# C  [libgl4es.so+0x1] Problematic frame:'),
    new Error('# An error report file with more information is saved as hs_err_pid123.log'),
    new Error('java.lang.UnsatisfiedLinkError: no lwjgl in java.library.path'),
    new Error('EXCEPTION_ACCESS_VIOLATION (0xc0000005)'),
    new Error('JNI_CreateJavaVM 失败 (rc=-1)'),
    { nativeCrash: true, message: 'JNI 指令崩溃' },
    Object.assign(new Error('boom'), { fatal: true }),
    Object.assign(new Error('boom'), { signal: 'SIGBUS' })
  ];
  for (const e of cases) assert.equal(G.isFatalError(e), true, `应判为致命: ${e.message}`);
});

test('isFatalError：普通业务错误 / 空值 / 原始字符串不误报', () => {
  const cases = [
    new Error('账号不存在'),
    new Error('gameDir 必须是绝对路径'),
    new Error('ECONNREFUSED'),
    new Error('该版本无客户端下载信息'),
    null, undefined, 'string error'
  ];
  for (const e of cases) assert.equal(G.isFatalError(e), false, `不应误报: ${e && e.message}`);
});

test('normalizeError：结构化字段完整，fatal 时 code=NATIVE_CRASH', () => {
  const fatal = G.normalizeError(new Error('SIGSEGV in libgl4es'), { channel: 'game:launch' });
  assert.equal(fatal.ok, false);
  assert.equal(fatal.fatal, true);
  assert.equal(fatal.code, 'NATIVE_CRASH');
  assert.equal(fatal.channel, 'game:launch');
  assert.match(fatal.error, /SIGSEGV/);

  const plain = G.normalizeError(new Error('账号不存在'), { channel: 'auth:remove' });
  assert.equal(plain.ok, false);
  assert.equal(plain.fatal, false);
  assert.equal(plain.code, 'IPC_HANDLER_ERROR');
  assert.equal(plain.error, '账号不存在');
});

test('normalizeError：带 signal 的 Error 保留信号字段；字符串抛出值也能归一化', () => {
  const e = Object.assign(new Error('native died'), { signal: 'SIGSEGV' });
  const r = G.normalizeError(e, { channel: 'probe.ping' });
  assert.equal(r.signal, 'SIGSEGV');
  assert.equal(G.normalizeError('oops', {}).error, 'oops');
  assert.equal(G.normalizeError(null, {}).error, '未知错误');
});

test('buildFatalReport：字段与 CrashDialog 完全对齐，含可读建议与证据', () => {
  const err = Object.assign(new Error('SIGSEGV (0xb) in libgl4es.so'), { signal: 'SIGSEGV' });
  const r = G.buildFatalReport(err, 'game:launch', { now: 123456 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NATIVE_CRASH');
  assert.equal(r.severity, 'fatal');
  assert.equal(r.source, 'ipc');
  assert.equal(r.stream, 'ipc');
  assert.equal(r.at, 123456);
  assert.match(r.reason, /SIGSEGV/);
  assert.match(r.reason, /game:launch/);
  assert.ok(Array.isArray(r.suggestions) && r.suggestions.length > 0);
  assert.ok(Array.isArray(r.evidence) && r.evidence.some(x => x.includes('signal=SIGSEGV')));
  assert.match(r.human, /建议/);
});

test('wrapHandler：成功结果原样透传（同步 / 异步 / 对象 / undefined）', async () => {
  const sync = G.wrapHandler('a', () => ({ ok: true, n: 1 }));
  assert.deepEqual(await sync(null, 'x'), { ok: true, n: 1 });
  const asyncFn = G.wrapHandler('b', async (evt, a, b) => a + b);
  assert.equal(await asyncFn(null, 2, 3), 5);
  const undef = G.wrapHandler('c', () => undefined);
  assert.equal(await undef(null), undefined);
});

test('wrapHandler：同步抛错被拦截并返回结构化错误，绝不 rethrow', async () => {
  const wrapped = G.wrapHandler('game:launch', () => { throw new Error('账号不存在'); });
  const r = await wrapped(null, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, '账号不存在');
  assert.equal(r.fatal, false);
});

test('wrapHandler：Promise reject 同样被拦截', async () => {
  const wrapped = G.wrapHandler('modrinth:install', async () => { throw new Error('sha512 不符'); });
  const r = await wrapped(null, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /sha512/);
});

test('wrapHandler：fatal 错误触发 onFatal 一次，报告可直接交给 CrashDialog', async () => {
  let report = null;
  let calls = 0;
  const wrapped = G.wrapHandler('game:launch', () => { throw new Error('SIGSEGV in libjvm.so'); }, {
    onFatal: (r) => { report = r; calls++; },
    now: () => 999
  });
  const r = await wrapped(null, {});
  assert.equal(r.fatal, true);
  assert.equal(calls, 1);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'NATIVE_CRASH');
  assert.equal(report.source, 'ipc');
  assert.equal(report.at, 999);
  assert.ok(report.suggestions.length > 0);
});

test('wrapHandler：非 fatal 不触发 onFatal', async () => {
  let calls = 0;
  const wrapped = G.wrapHandler('auth:remove', () => { throw new Error('账号不存在'); }, { onFatal: () => calls++ });
  const r = await wrapped(null, {});
  assert.equal(r.fatal, false);
  assert.equal(calls, 0);
});

test('wrapHandler：onFatal / onError 自身抛错不掩盖原始错误', async () => {
  const wrapped = G.wrapHandler('x', () => { throw new Error('SIGSEGV'); }, {
    onFatal: () => { throw new Error('上报通道故障'); },
    onError: () => { throw new Error('监控故障'); }
  });
  const r = await wrapped(null, {});
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.error, /SIGSEGV/);
});

test('wrapHandler：onError 收到归一化错误与原始异常', async () => {
  let seen = null;
  let raw = null;
  const wrapped = G.wrapHandler('download:smart', () => { throw new Error('boom'); }, {
    onError: (n, e) => { seen = n; raw = e; }
  });
  await wrapped(null, {});
  assert.equal(seen.ok, false);
  assert.equal(seen.channel, 'download:smart');
  assert.match(raw.message, /boom/);
});

test('wrapHandler：evt 与多参数完整透传给原始 handler', async () => {
  const seen = [];
  const wrapped = G.wrapHandler('multi', (...args) => { seen.push(...args); return 'ok'; });
  const evt = { sender: 1 };
  assert.equal(await wrapped(evt, 'a', 2, { x: 1 }), 'ok');
  assert.equal(seen[0], evt);
  assert.equal(seen[1], 'a');
  assert.equal(seen[2], 2);
  assert.deepEqual(seen[3], { x: 1 });
});
