'use strict';
/**
 * aiCrashDigest.test.cjs — 0.9.0 模块三A：AI 可读崩溃日志摘要 TDD
 *
 * 验证目标（对应「确保 AI 能正常读取崩溃日志堆栈」）：
 *  1) JVM hs_err / JNI Segfault 的原生帧（此前 logCleaner 读不到）能被解析到 module/offset
 *  2) 四路输入（analyzer / guardian report / logCleaner / 原始日志）聚合成单一结构化 digest
 *  3) 全程脱敏（token / uuid / email / IP 不出现在 markdown）
 *  4) 输出有界（超大日志不撑爆 AI 上下文），且如实标注 truncated
 *  5) 不伪造：空输入/未识别特征返回空数组与 unknown，绝不生成"像"的堆栈
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const digest = require('../engine/crash/aiDigest.cjs');
const analyzer = require('../engine/crash/analyzer.cjs');
const guardian = require('../engine/crash/guardian.cjs');
const logCleaner = require('../engine/crash/logCleaner.cjs');

const HS_ERR = [
  '# A fatal error has been detected by the Java Runtime Environment:',
  '#',
  '#  SIGSEGV (0xb) at pc=0x00007f9a1c2b3d, pid=4242, tid=4243',
  '#',
  '# JRE version: OpenJDK Runtime Environment (17.0.9)',
  '# Problematic frame:',
  '# C  [libgl4es_114.so+0x1a2b3]  glDrawElements+0x33',
  '#',
  'Native frames: (J=compiled Java code, j=interpreted, Vv=VM code, C=native code)',
  'C  [libgl4es_114.so+0x1a2b3]  glDrawElements+0x33',
  'C  [libjvm.so+0x8ab123]  JVM_ResolveClass+0x12',
  'j  net.minecraft.client.renderer.GameRenderer.render()V+0',
  '',
  '[error occurred during error reporting, id 0xb]'
].join('\n');

const JAVA_LOG = [
  '[16:32:10] [main/INFO]: Starting Minecraft 1.20.1',
  '[16:32:12] [main/ERROR]: java.lang.RuntimeException: Rendering entity in world',
  '\tat com.example.badmod.Renderer.render(Renderer.java:42)',
  '\tat net.minecraft.client.renderer.GameRenderer.render(GameRenderer.java:100)',
  'Caused by: java.io.FileNotFoundException: missing asset',
  '\tat com.example.badmod.Loader.load(Loader.java:17)',
  '\t... 12 more',
  '---- Minecraft Crash Report ----',
  'Description: Rendering entity in world',
  'java.lang.OutOfMemoryError: Java heap space',
  '---- End of report ----'
].join('\n');

// ==================== 1. hs_err / JNI 原生帧解析（模块一C 的 Segfault 场景） ====================
test('parseNativeFrames：从 hs_err 解析 SIGSEGV / Problematic frame / C 帧 module+offset', () => {
  const n = digest.parseNativeFrames(HS_ERR);
  assert.equal(n.hasNativeCrash, true);
  assert.equal(n.signal, 'SIGSEGV');
  assert.ok(n.problematicFrame && n.problematicFrame.includes('libgl4es_114.so'));
  const mods = n.frames.map(f => f.module);
  assert.ok(mods.some(m => m.includes('libgl4es_114.so')), '应识别渲染降级链 .so');
  assert.ok(mods.some(m => m.includes('libjvm.so')), '应识别 libjvm.so');
  const glFrame = n.frames.find(f => f.module.includes('libgl4es'));
  assert.equal(glFrame.kind, 'C');
  assert.equal(glFrame.offset, '0x1a2b3');
});

test('parseNativeFrames：去重同一 module+offset（Problematic 与 Native frames 重复出现）', () => {
  const n = digest.parseNativeFrames(HS_ERR);
  const gl = n.frames.filter(f => f.module.includes('libgl4es'));
  assert.equal(gl.length, 1, '同一原生帧不应重复');
});

test('parseNativeFrames：普通 Java 日志不误报原生崩溃', () => {
  const n = digest.parseNativeFrames('[main/ERROR]: java.lang.NullPointerException\n\tat a.B.c(B.java:1)');
  assert.equal(n.hasNativeCrash, false);
  assert.equal(n.signal, null);
  assert.equal(n.frames.length, 0);
});

test('parseNativeFrames：Windows 访问冲突 / 空输入安全', () => {
  const n = digest.parseNativeFrames('# EXCEPTION_ACCESS_VIOLATION (0xC0000005) at pc=0x1');
  assert.equal(n.hasNativeCrash, true);
  const empty = digest.parseNativeFrames('');
  assert.equal(empty.hasNativeCrash, false);
  assert.deepEqual(empty.frames, []);
});

// ==================== 2. 四路聚合 ====================
test('buildAiDigest：聚合 analyzer + logCleaner + guardian report + 原生帧', () => {
  const analysis = analyzer.analyzeCrash({ log: JAVA_LOG, exitCode: 1 });
  const clean = logCleaner.cleanLatestLog(JAVA_LOG, { maxLines: 120 });
  const g = new guardian.CrashGuardian({ now: () => 1700000000000 });
  let report = null;
  g.on('fatal', r => { report = r; });
  g.ingest('---- Minecraft Crash Report ----');
  g.ingest('java.lang.OutOfMemoryError: Java heap space');

  const d = digest.buildAiDigest({ log: JAVA_LOG + '\n' + HS_ERR, analysis, clean, report });
  assert.equal(d.ok, true);
  assert.equal(d.severity, 'fatal');
  assert.ok(d.primary && d.primary.code, '应有主诊断');
  assert.ok(d.findings.length > 0, '应有诊断条目');
  assert.ok(d.javaStackTraces.length >= 1, '应有 Java 异常堆栈');
  assert.equal(d.native.hasNativeCrash, true, '应混入原生帧');
  assert.ok(d.human.length > 0, '应有人话结论');
  assert.ok(d.markdown.includes('## 诊断条目'));
  assert.ok(d.markdown.includes('## JVM / JNI 原生崩溃帧'));
  assert.ok(d.markdown.includes('## Java 异常堆栈'));
});

test('buildAiDigest：仅传原始日志也能自动调用 analyzer + logCleaner 兜底', () => {
  const d = digest.buildAiDigest({ log: JAVA_LOG });
  assert.equal(d.ok, true);
  assert.ok(d.findings.length > 0);
  assert.ok(d.javaStackTraces.length >= 1);
  assert.equal(d.redacted, true);
});

test('buildAiDigest：Caused by 链与可疑 Mod 进入 digest', () => {
  const d = digest.buildAiDigest({ log: JAVA_LOG });
  assert.ok(d.causedBy.some(x => x.includes('FileNotFoundException')), 'Caused by 链应可达');
  assert.ok(Array.isArray(d.modSuspects));
});

// ==================== 3. 脱敏（AI 读日志不得外泄 token） ====================
test('buildAiDigest：accessToken / uuid / email / IP 全脱敏，绝不出现在 markdown', () => {
  const sensitive = [
    '[main/INFO]: Launching with --accessToken SUPERSECRET_TOKEN_abc123 --uuid 069a79f4-44e9-4726-a5be-fca90e38aaf5',
    '[main/INFO]: contact player@example.com or 192.168.1.99:25565',
    '[main/ERROR]: java.lang.OutOfMemoryError: Java heap space',
    '\tat com.bad.Mod.crash(Mod.java:1)'
  ].join('\n');
  const d = digest.buildAiDigest({ log: sensitive });
  const md = d.markdown;
  assert.ok(!md.includes('SUPERSECRET_TOKEN_abc123'), 'token 泄漏');
  assert.ok(!md.includes('069a79f4-44e9-4726-a5be-fca90e38aaf5'), 'uuid 泄漏');
  assert.ok(!md.includes('player@example.com'), 'email 泄漏');
  assert.ok(!md.includes('192.168.1.99'), 'IP 泄漏');
  assert.equal(d.redacted, true);
});

// ==================== 4. 有界 & 不伪造 ====================
test('buildAiDigest：超大日志输出恒有界（源头限流生效，无需兜底截断）', () => {
  const lines = [];
  for (let i = 0; i < 20000; i++) {
    lines.push(`[main/ERROR]: java.lang.RuntimeException: boom-${i}`);
    lines.push(`\tat pkg.Mod${i % 50}.run(Mod.java:${i})`);
  }
  const d = digest.buildAiDigest({ log: lines.join('\n') });
  assert.ok(d.findings.length <= digest.AI_LIMITS.FINDINGS);
  assert.ok(d.javaStackTraces.length <= digest.AI_LIMITS.STACK_TRACES);
  assert.ok(d.javaStackTraces.every(t => t.frames.length <= digest.AI_LIMITS.FRAMES_PER_TRACE));
  assert.ok(d.evidence.length <= digest.AI_LIMITS.EVIDENCE);
  assert.ok(d.markdown.length <= digest.AI_LIMITS.MARKDOWN_CHARS + 100, 'markdown 必须有硬上限');
  // 源头各字段已限流，markdown 天然不超预算：truncated 应为 false（这是正确行为，不是缺陷）
  assert.equal(typeof d.truncated, 'boolean');
  assert.equal(d.truncated, false);
});

test('buildAiDigest：极端超长结构化输入触发 markdown 兜底截断并标注 truncated', () => {
  // 直接喂超长结构化字段（绕过源头日志限流），验证最终 MARKDOWN_CHARS 硬上限生效
  const long = 'X'.repeat(230);
  const fakeAnalysis = {
    severity: 'fatal',
    primary: { code: 'STRESS', title: long, severity: 'fatal' },
    findings: Array.from({ length: 8 }, (_, i) => ({
      code: 'F' + i, title: long, severity: 'fatal',
      matches: [long, long, long], suggestions: [long]
    })),
    causedBy: [], modSuspects: [], summary: long
  };
  const fakeClean = {
    stackTraces: Array.from({ length: 4 }, () => ({
      header: long, frames: Array.from({ length: 14 }, () => long), causedBy: []
    })),
    keyLines: [], lines: []
  };
  const d = digest.buildAiDigest({ analysis: fakeAnalysis, clean: fakeClean });
  assert.equal(d.truncated, true, '超预算应触发兜底截断');
  assert.ok(d.markdown.length <= digest.AI_LIMITS.MARKDOWN_CHARS + 100);
  assert.ok(d.markdown.includes('已截断'));
});

test('buildAiDigest：空输入不伪造，如实返回 ok:false / 空结构', () => {
  const d = digest.buildAiDigest({});
  assert.equal(d.ok, false);
  assert.deepEqual(d.findings, []);
  assert.deepEqual(d.javaStackTraces, []);
  assert.equal(d.native.hasNativeCrash, false);
  assert.equal(d.primary, null);
  assert.ok(d.markdown.includes('AI 可读'), '即便空输入也给出可读骨架，不含伪造数据');
  assert.ok(!/at\s+[\w$.]+\(/.test(d.markdown), '不得生成"看起来像"的堆栈帧');
});

test('AI_LIMITS：全部为正整数且冻结，防运行时篡改', () => {
  assert.ok(Object.isFrozen(digest.AI_LIMITS));
  for (const [k, v] of Object.entries(digest.AI_LIMITS)) {
    assert.ok(Number.isInteger(v) && v > 0, `${k} 应为正整数`);
  }
});

// ==================== 5. 与模块一C ipcGuard 报告联动 ====================
test('buildAiDigest：ipcGuard 的 fatal report（含 Error.stack 片段）可喂入聚合', () => {
  const { wrapHandler } = require('../engine/crash/ipcGuard.cjs');
  let captured = null;
  const handler = wrapHandler('game:launch', async () => {
    const e = new Error('JNI_CreateJavaVM failed: libjvm.so missing');
    e.signal = 'SIGSEGV';
    e.stack = 'Error: JNI_CreateJavaVM failed\n    at JvmBridge.start (JvmBridge.java:88)\n    at NativeCommandRouter.dispatch (NativeCommandRouter.java:120)';
    throw e;
  }, { onFatal: r => { captured = r; }, now: () => 1700000000000 });
  return handler().then(r => {
    assert.equal(r.fatal, true);
    assert.ok(captured, 'ipcGuard 应产出 fatal report');
    const d = digest.buildAiDigest({ report: captured });
    assert.equal(d.ok, true);
    assert.equal(d.severity, 'fatal');
    assert.ok(d.markdown.includes('NATIVE_CRASH') || d.primary.code === 'NATIVE_CRASH');
    assert.ok(d.evidence.length > 0, 'guardian/ipcGuard 的 evidence 应可达');
  });
});
