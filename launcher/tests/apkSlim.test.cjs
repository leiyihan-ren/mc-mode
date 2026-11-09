'use strict';
/**
 * apkSlim.test.cjs — 0.9.0 模块二B：APK 体积瘦身 TDD
 *
 * 覆盖：规则单一数据源、白名单式分类、真实目录瘦身集成、缺文件拒绝保护、
 *       产物级审计（含模拟构建脚本「Python zip 解析 → Node audit」端到端）、构建脚本接线守卫。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools/apk-slim.cjs');
const slim = require('../tools/apk-slim.cjs');

function mk(root, rel, content = 'x') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function makeRuntime(withModules = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-slim-'));
  if (withModules) mk(root, 'lib/modules', 'MODULES');
  for (const p of [
    'conf/security/java.security', 'lib/security/cacerts', 'lib/tzdb.dat',
    'lib/jrt-fs.jar', 'lib/jspawnhelper', 'lib/jvm.cfg',
    'lib/fonts/LucidaSansRegular.ttf', 'bin/java', 'release',
    'conf/net.properties', 'legal/java.base/LICENSE'
  ]) mk(root, p);
  // 应被删除的编译期/开发期文件
  mk(root, 'lib/ct.sym', 'C'.repeat(2048));
  mk(root, 'lib/classlist', 'CLASS');
  mk(root, 'man/man1/java.1', 'MAN');
  mk(root, 'lib/jfr/default.jfc', 'JFR');
  mk(root, 'conf/management/management.properties', 'JMX');
  mk(root, 'conf/sdp/sdp.conf.template', 'SDP');
  mk(root, 'bin/keytool', 'TOOL');
  mk(root, 'bin/jfr', 'TOOL');
  mk(root, 'lib/fontconfig.Linux.properties.src', 'SRC');
  return root;
}

// ==================== 1. 规则与分类 ====================

test('规则文件存在且字段完整（单一数据源）', () => {
  const r = slim.loadRules();
  for (const k of ['dropExact', 'dropPrefix', 'dropSuffix', 'dropBinExcept',
    'mustKeepRuntime', 'apkMustKeep', 'apkForbiddenExact', 'apkForbiddenPrefix']) {
    assert.ok(Array.isArray(r[k]) && r[k].length > 0, `规则字段 ${k} 应为非空数组`);
  }
  assert.ok(r.mustKeepRuntime.includes('lib/modules'), 'JRE modules 必须在保留白名单');
});

test('classify: 编译期/开发期文件 → drop', () => {
  for (const p of [
    'lib/ct.sym', 'lib/classlist', 'man/man1/java.1', 'lib/jfr/default.jfc',
    'conf/management/management.properties', 'conf/sdp/sdp.conf.template',
    'bin/keytool', 'bin/javac', 'lib/fontconfig.Linux.properties.src',
    'lib/psfont.properties.ja', 'lib/psfontj2d.properties'
  ]) {
    assert.equal(slim.classify(p), 'drop', `${p} 应被删除`);
  }
});

test('classify: 运行时依赖与白名单 → keep（绝不误删功能文件）', () => {
  for (const p of [
    'lib/modules', 'conf/security/java.security', 'lib/security/cacerts',
    'lib/tzdb.dat', 'lib/jrt-fs.jar', 'lib/jspawnhelper', 'lib/jvm.cfg',
    'lib/fonts/LucidaSansRegular.ttf', 'bin/java', 'release',
    'conf/net.properties', 'legal/java.base/LICENSE',
    'lib/fontconfig.bfc', 'some/unknown/file.dat'
  ]) {
    assert.equal(slim.classify(p), 'keep', `${p} 必须保留`);
  }
});

test('classify: 白名单式 —— 不在删除规则内的一律保留；bin/java 例外保留', () => {
  assert.equal(slim.classify('bin/java'), 'keep');
  assert.equal(slim.classify('bin/keytool'), 'drop');
  assert.equal(slim.classify('bin/sub/nested'), 'keep', 'bin 子目录内容保守保留');
  assert.equal(slim.classify('./lib/ct.sym'), 'drop', '相对路径前缀应归一化');
  const r = slim.loadRules();
  for (const p of r.mustKeepRuntime) {
    assert.equal(slim.classify(p), 'keep', `mustKeepRuntime 项必须 keep: ${p}`);
  }
});

// ==================== 2. 真实目录瘦身集成 ====================

test('planSlim: 删除计划命中预期集合、释放字节精确、漏掉必需文件时报告', () => {
  const root = makeRuntime();
  try {
    const plan = slim.planSlim(root);
    assert.equal(plan.missingMustKeep.length, 0);
    const drops = plan.drops.map(d => d.rel);
    for (const p of ['lib/ct.sym', 'man/man1/java.1', 'bin/keytool', 'lib/jfr/default.jfc',
      'conf/management/management.properties', 'lib/classlist']) {
      assert.ok(drops.includes(p), `计划应包含 ${p}`);
    }
    assert.ok(!drops.includes('lib/modules'), 'modules 绝不可进删除计划');
    assert.ok(!drops.includes('bin/java'), 'bin/java 绝不可进删除计划');
    const expect = plan.drops.reduce((a, d) => a + d.size, 0);
    assert.equal(plan.freedBytes, expect);
    assert.ok(plan.freedBytes > 2048, '应统计出真实释放字节');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applySlim: 真实删除且必需文件全部存活', () => {
  const root = makeRuntime();
  try {
    const report = slim.applySlim(root);
    assert.equal(report.applied, true);
    assert.equal(report.afterMissing.length, 0, '瘦身后必需文件不得缺失');
    assert.equal(fs.existsSync(path.join(root, 'lib/ct.sym')), false);
    assert.equal(fs.existsSync(path.join(root, 'man/man1/java.1')), false);
    assert.equal(fs.existsSync(path.join(root, 'bin/keytool')), false);
    assert.equal(fs.existsSync(path.join(root, 'lib/modules')), true);
    assert.equal(fs.readFileSync(path.join(root, 'lib/modules'), 'utf8'), 'MODULES');
    assert.equal(fs.existsSync(path.join(root, 'bin/java')), true);
    assert.equal(fs.existsSync(path.join(root, 'conf/security/java.security')), true);
    assert.equal(fs.existsSync(path.join(root, 'legal/java.base/LICENSE')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applySlim: 缺必需文件时拒绝执行，且不删任何文件', () => {
  const root = makeRuntime(false); // 故意缺 lib/modules
  try {
    assert.throws(() => slim.applySlim(root), /拒绝瘦身/);
    assert.equal(fs.existsSync(path.join(root, 'lib/ct.sym')), true, '拒绝后不得产生任何删除');
    assert.equal(fs.existsSync(path.join(root, 'man/man1/java.1')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('planSlim(dryRun): 只出计划不落盘', () => {
  const root = makeRuntime();
  try {
    const report = slim.applySlim(root, { dryRun: true });
    assert.equal(report.applied, false);
    assert.ok(report.drops.length > 0);
    assert.equal(fs.existsSync(path.join(root, 'lib/ct.sym')), true, 'dry-run 不得删文件');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ==================== 3. 产物级审计 ====================

test('auditApkEntries: 合规 APK 通过；缺必需 / 有残留均不通过', () => {
  const r = slim.loadRules();
  const good = [
    ...r.apkMustKeep,
    'assets/public/assets/index-ABC.js', 'lib/arm64-v8a/libOSMesa.so',
    'assets/runtime/conf/net.properties', 'assets/runtime/legal/java.base/LICENSE'
  ];
  assert.equal(slim.auditApkEntries(good).ok, true);

  const missing = slim.auditApkEntries(good.filter(n => n !== 'assets/runtime/lib/modules'));
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.includes('assets/runtime/lib/modules'));

  const leftover = slim.auditApkEntries([...good, 'assets/runtime/lib/ct.sym', 'assets/runtime/man/man1/java.1']);
  assert.equal(leftover.ok, false);
  assert.ok(leftover.leftover.some(n => n.endsWith('ct.sym')));
  assert.ok(leftover.leftover.some(n => n.includes('man/man1/')));
});

test('端到端: 模拟构建脚本「Python 解析 zip → Node audit」判定链路', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-slimzip-'));
  const zip = path.join(dir, 'sample.apk');
  const r = slim.loadRules();
  const names = [...r.apkMustKeep, 'assets/runtime/lib/ct.sym', 'assets/runtime/man/man1/java.1'];
  try {
    execFileSync('python3.11', ['-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(n,b"x") for n in sys.argv[2:]]; z.close()',
      zip, ...names]);
    const listed = execFileSync('python3.11', ['-c',
      'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zip],
      { encoding: 'utf8' }).trim().split('\n');
    // 模拟构建脚本把 names 交给 Node audit CLI（应因残留退出非 0）
    const bad = spawnSync('node', [CLI, 'audit'], { input: listed.join('\n'), encoding: 'utf8' });
    assert.notEqual(bad.status, 0, '含瘦身残留时 audit 必须失败');
    assert.match(bad.stdout, /apk-slim\]\[audit\]/);
    // 去掉残留后应通过
    const clean = listed.filter(n => !n.includes('ct.sym') && !n.includes('man/man1/'));
    const ok = spawnSync('node', [CLI, 'audit'], { input: clean.join('\n'), encoding: 'utf8' });
    assert.equal(ok.status, 0, '合规 APK 审计应通过');
    assert.match(ok.stdout, /必需文件 齐全/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: apply/plan 在真实源 runtime 上输出真实字节（不落盘）', () => {
  const runtime = path.join(ROOT, 'android/app/src/main/assets/runtime');
  if (!fs.existsSync(runtime)) return; // 源目录缺失时跳过
  const out = execFileSync('node', [CLI, 'plan', runtime], { encoding: 'utf8' });
  assert.match(out, /释放 \d+ bytes/);
  assert.match(out, /必需文件复检: OK/);
  assert.match(out, /dry-run/);
  assert.equal(fs.existsSync(path.join(runtime, 'lib/ct.sym')), true, 'plan 不得删真实源文件');
});

// ==================== 4. 构建脚本接线守卫 ====================

test('build-unified-apk.sh 已接入瘦身与产物级审计（防回退）', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/build-unified-apk.sh'), 'utf8');
  assert.match(s, /\[5\.5\/9\].*APK 体积瘦身/);
  assert.match(s, /apk-slim\.cjs"\s+apply\s+"\$ASSET_DST\/runtime"/, '应在打包前真实执行瘦身');
  assert.match(s, /apk-slim\.cjs'\]|slim_cli, 'audit'/, '产物校验应调用 Node audit');
  assert.match(s, /subprocess\.run\(\['node', slim_cli, 'audit'\]/);
  assert.match(s, /arm64-v8a/, '应保留 ABI 过滤规则');
  assert.match(s, /apk-slim-rules\.json|apk-slim\.cjs/, '规则应来自单一数据源');
  // 原有产物级校验不得被削弱
  for (const key of ['本轮 React bundle', 'JRE libjvm.so', 'GL4ES 渲染库', 'JNI 指令桥 so', 'JRE 运行时模块']) {
    assert.ok(s.includes(key), `原有校验项不得丢失: ${key}`);
  }
});

test('构建脚本: A/B 对比开关与 .so 压缩开关可回退、默认启用且幂等', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/build-unified-apk.sh'), 'utf8');
  assert.match(s, /MCNEXT_SKIP_SLIM:-0/, '应支持 A/B 基线对比开关');
  assert.match(s, /MCNEXT_LEGACY_PACKAGING="\$\{MCNEXT_LEGACY_PACKAGING:-1\}"/, '默认应启用 .so 压缩（实测 -35.6%）');
  assert.match(s, /useLegacyPackaging = true/, '应注入 AGP legacy packaging');
  assert.match(s, /removed experimental useLegacyPackaging/, '应能幂等剥离注入（=0 回退）');
  assert.match(s, /跳过瘦身残留检查/, '基线构建应跳过残留审计但保留原有产物校验');
});
