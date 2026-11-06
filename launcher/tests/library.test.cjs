'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRules, defaultEnv, nativesClassifier, buildClasspath } = require('../engine/library');

const LINUX = { os: 'linux', arch: 'x64', features: {} };
const WIN64 = { os: 'windows', arch: 'x64', features: {} };
const MAC_ARM = { os: 'osx', arch: 'arm64', features: {} };

test('无规则默认允许', () => {
  assert.equal(evaluateRules(null, LINUX), true);
  assert.equal(evaluateRules([], LINUX), true);
});

test('os 规则过滤（官方语义: 有规则默认禁止）', () => {
  const rules = [{ action: 'allow', os: { name: 'windows' } }];
  assert.equal(evaluateRules(rules, WIN64), true);
  assert.equal(evaluateRules(rules, LINUX), false);
});

test('disallow 规则', () => {
  const rules = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.equal(evaluateRules(rules, MAC_ARM), false);
  assert.equal(evaluateRules(rules, LINUX), true);
});

test('多规则最后匹配者生效（官方语义）', () => {
  const rules = [
    { action: 'disallow' },
    { action: 'allow', os: { name: 'linux' } }
  ];
  assert.equal(evaluateRules(rules, LINUX), true);
  assert.equal(evaluateRules(rules, WIN64), false);
});

test('arch 规则', () => {
  const rules = [{ action: 'allow', os: { name: 'osx', arch: 'aarch64' } }];
  // 精确匹配: arm64 != aarch64 字符串 -> false（保守语义）
  assert.equal(evaluateRules(rules, MAC_ARM), false);
  const rules2 = [{ action: 'allow', os: { name: 'osx', arch: 'arm64' } }];
  assert.equal(evaluateRules(rules2, MAC_ARM), true);
});

test('features 规则: is_dedicated_server', () => {
  const rules = [{ action: 'allow', features: { is_dedicated_server: true } }];
  assert.equal(evaluateRules(rules, { os: 'linux', arch: 'x64', features: { is_dedicated_server: true } }), true);
  assert.equal(evaluateRules(rules, { os: 'linux', arch: 'x64', features: {} }), false);
});

test('defaultEnv 推断当前平台', () => {
  const e = defaultEnv();
  assert.ok(['windows', 'osx', 'linux'].includes(e.os));
  assert.ok(['x86', 'x64', 'arm64'].includes(e.arch));
});

test('nativesClassifier 映射', () => {
  const lib = { natives: { linux: 'natives-linux', windows: 'natives-windows-${arch}', osx: 'natives-macos' } };
  assert.equal(nativesClassifier(lib, LINUX), 'natives-linux');
  assert.equal(nativesClassifier(lib, WIN64), 'natives-windows-64');
  assert.equal(nativesClassifier({}, LINUX), null);
});

test('buildClasspath: 规则过滤 + 缺失检测 + gameJar 置后', () => {
  const vj = {
    libraries: [
      { name: 'com.mojang:blocklist:1.0.10' },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] },
      { name: 'ca.weblite:java-objc-bridge:1.1', rules: [{ action: 'allow', os: { name: 'osx' } }] }
    ]
  };
  const r = buildClasspath(vj, { repoRoot: '/tmp/fake-repo', env: LINUX, gameJarPath: '/games/1.21.11.jar' });
  // blocklist 在 classpath; natives 也在 classpath(官方行为)且被收集; osx bridge 被过滤
  assert.ok(r.classpath.some(p => p.includes('blocklist')), 'blocklist 应在 classpath');
  assert.ok(!r.classpath.some(p => p.includes('java-objc-bridge')), 'osx 库应被过滤');
  assert.ok(r.natives.some(n => n.classifier === 'natives-linux'), 'natives 应被收集');
  assert.equal(r.classpath[r.classpath.length - 1], '/games/1.21.11.jar', 'gameJar 应置后');
  assert.equal(r.missing.length, 2, '两个不存在的库都应报缺失');
  const paths = r.missing.map(m => m.path);
  assert.ok(paths.includes('com/mojang/blocklist/1.0.10/blocklist-1.0.10.jar'));
  assert.ok(paths.some(p => p.includes('natives-linux')), 'natives 缺失也应上报');
});

test('buildClasspath: extraJars 前置（loader jar 优先）', () => {
  const vj = { libraries: [{ name: 'com.mojang:blocklist:1.0.10' }] };
  const r = buildClasspath(vj, { repoRoot: '/tmp/fake-repo', env: LINUX, gameJarPath: '/g.jar', extraJars: ['/loader.jar'] });
  assert.equal(r.classpath[0], '/loader.jar', 'loader jar 应最前');
  assert.equal(r.classpath[r.classpath.length - 1], '/g.jar', 'gameJar 应最后');
});
