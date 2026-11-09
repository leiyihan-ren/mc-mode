/**
 * native-crash-guard.test.cjs — 0.9.0 模块一C：JNI / IPC 防崩溃防线接线守卫
 *
 * 纯静态源码扫描，不依赖 Electron / NDK / 真机 / 公网。四层防线任一处被删改这里立刻失败：
 *   L1 Node  ipcGuard → ipc.cjs handle → send('game:crash')
 *   L2 前端   services/bridge.js 兜底广播 → CrashDialog 双通道去重弹窗
 *   L3 JNI    bridge_commands.c 信号防护 + 结构化返回 + 崩溃标记
 *   L3 Java   NativeCrashReport 解析 + NativeCommandRouter catch Throwable / 上报
 *
 * 真实语法由 gcc -c 校验 C、Gradle JUnit 校验 Java（见交付报告），本套件只保证「接线不回退」。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('L3 C：signal 防护用 sigsetjmp/siglongjmp + sigaction，且 TLS 只回跳同线程', () => {
  const c = read('android/bridge/jni/bridge_commands.c');
  for (const s of ['sigsetjmp', 'siglongjmp', 'sigaction', 'siginfo_t', 'SA_SIGINFO']) {
    assert.match(c, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `C 层缺少 ${s}`);
  }
  // 关键：jmp_buf 与 active 标记必须是 __thread，杜绝跨线程 longjmp 破坏 JVM
  assert.match(c, /__thread\s+sigjmp_buf\s+t_guard_jmp/);
  assert.match(c, /__thread\s+volatile\s+sig_atomic_t\s+t_guard_active/);
  assert.match(c, /guard_begin\s*\(\s*void\s*\)/);
  assert.match(c, /guard_end\s*\(\s*void\s*\)/);
});

test('L3 C：崩溃标记 async-signal-safe 落盘，返回结构化 nativeCrash，清理 JNI 异常', () => {
  const c = read('android/bridge/jni/bridge_commands.c');
  assert.match(c, /persist_crash_marker/);
  assert.match(c, /\bopen\(/, '应使用 open 落盘');
  assert.match(c, /\bwrite\(/, '应使用 write 落盘');
  assert.match(c, /\bclose\(/, '应 close fd');
  assert.match(c, /nativeCrash\\":true/);
  assert.match(c, /ExceptionCheck/);
  assert.match(c, /ExceptionClear/);
  // 不覆盖 ART 常驻 handler：窗口结束与 longjmp 分支都必须恢复原 handler
  const restores = c.match(/guard_restore\(\);/g) || [];
  assert.ok(restores.length >= 2, 'guard_end 与 longjmp 分支都必须恢复原 signal handler');
});

test('L3 C：新增崩溃防线指令已注册进函数表', () => {
  const c = read('android/bridge/jni/bridge_commands.c');
  assert.match(c, /\{"probe\.crashGuard",\s*h_crash_guard\}/);
  assert.match(c, /\{"probe\.crashSelfTest",\s*h_crash_selftest\}/);
  assert.match(c, /lastCrash/);
});

test('L3 Java：NativeCrashReport 纯 Java 零 org.json（保证 JVM 单测可跑）', () => {
  const j = read('android/app/src/main/java/com/mcnext/launcher/NativeCrashReport.java');
  assert.doesNotMatch(j, /import\s+org\.json/, '不得依赖 android.jar 的 org.json');
  for (const fn of ['signalName', 'fromDispatch', 'fromMarker', 'fromThrowable']) {
    assert.match(j, new RegExp('static .*' + fn + '\\s*\\('), `缺少 ${fn}`);
  }
});

test('L3 Java：Router catch Throwable（覆盖 Error）+ 三类崩溃上报 + 防线安装', () => {
  const j = read('android/bridge/java/com/mcnext/launcher/NativeCommandRouter.java');
  assert.match(j, /catch\s*\(\s*Throwable\s+t\s*\)/, '必须捕获 Throwable 而非仅 Exception');
  assert.match(j, /ensureCrashGuard\s*\(\s*\)/);
  assert.match(j, /flushPendingCrash\s*\(\s*\)/);
  assert.match(j, /NativeCrashReport\.fromDispatch/);
  assert.match(j, /NativeCrashReport\.fromThrowable/);
  assert.match(j, /NativeCrashReport\.fromMarker/);
  assert.match(j, /emitCrashIfAny\(NativeCrashReport\.Report/);
  assert.match(j, /"probe\.crashGuard"/);
  assert.match(j, /emit\("game:crash"/);
});

test('L1 Node：ipcGuard 全局异常拦截与结构化错误', () => {
  const g = read('engine/crash/ipcGuard.cjs');
  for (const fn of ['isFatalError', 'normalizeError', 'buildFatalReport', 'wrapHandler']) {
    assert.match(g, new RegExp('function ' + fn + '\\s*\\('), `缺少 ${fn}`);
  }
  assert.match(g, /normalized\.report\s*=\s*report/, '完整报告须随错误对象返回供前端兜底');
  assert.match(g, /NATIVE_FATAL_RE/);
  assert.match(g, /buildReport/, '须复用 guardian.buildReport 保证弹窗字段对齐');
});

test('L1 Node：ipc.cjs 的 handle() 已把每个 handler 套上防线并接 game:crash', () => {
  const ipc = read('electron/ipc.cjs');
  assert.match(ipc, /ipcGuard\.wrapHandler\(channel,\s*fn/);
  assert.match(ipc, /onFatal:\s*\(report\)\s*=>\s*send\('game:crash',\s*report\)/);
  assert.match(ipc, /HANDLERS\.set\(channel,\s*guarded\)/, 'dispatchChannel / /api/rpc 也必须走包装后的 handler');
  assert.match(ipc, /ipcMain\.handle\(channel,\s*guarded\)/);
});

test('L2 前端：Service 层 fatal 兜底广播，成功结果原样透传', () => {
  const s = read('src/services/bridge.js');
  assert.match(s, /mcnext:bridge-fatal/);
  assert.match(s, /function fatalDetail/);
  assert.match(s, /function broadcastFatal/);
  assert.match(s, /if \(d\) broadcastFatal\(d\)/);
  assert.match(s, /return r\s*\)?/, '成功结果不得被吞掉');
});

test('L2 前端：CrashDialog 双通道订阅 + 去重 + 卸载清理', () => {
  const d = read('src/features/shell/components/CrashDialog.jsx');
  assert.match(d, /api\.onGameCrash\(showReport\)/);
  assert.match(d, /addEventListener\('mcnext:bridge-fatal'/);
  assert.match(d, /removeEventListener\('mcnext:bridge-fatal'/);
  assert.match(d, /lastRef/, '双通道需要去重');
  assert.match(d, /setGameRunning\(false\)/, '崩溃必须复位 UI');
});

test('终局构建：新 Java 类与新 C 源码会被同步进 Capacitor 工程', () => {
  const sh = read('tools/build-unified-apk.sh');
  assert.match(sh, /\$SRC\/java\/com\/mcnext\/launcher\/"\*\.java/, '通配复制应包含 NativeCrashReport.java');
  assert.match(sh, /\$BRIDGE\/jni\/bridge_commands\.c/, 'C 源码须重新编译');
  assert.match(sh, /gen-bridge-contract\.cjs/);
});

test('契约：game:crash 仍是 native 事件，双端弹窗通道未被破坏', () => {
  const c = require('../engine/bridge/contract.cjs');
  assert.ok(c.EVENT_CHANNELS.includes('game:crash'));
  assert.ok(c.NATIVE_EVENTS.includes('game:crash'));
});
