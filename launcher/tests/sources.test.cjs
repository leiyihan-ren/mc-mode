'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mirrorCandidates, bmclJarUrl, bmclAssetUrl, OFFICIAL } = require('../engine/sources');

test('maven 源正确映射 BMCLAPI /maven/<path>', () => {
  const c = mirrorCandidates('https://libraries.minecraft.net/com/mojang/patching/1.0.0/patching-1.0.0.jar');
  assert.equal(c[0], 'https://libraries.minecraft.net/com/mojang/patching/1.0.0/patching-1.0.0.jar');
  assert.ok(c.includes('https://bmclapi2.bangbang93.com/maven/com/mojang/patching/1.0.0/patching-1.0.0.jar'));
});

test('forge/neoforge/fabric/quilt maven 主机均映射', () => {
  for (const host of ['maven.minecraftforge.net', 'maven.neoforged.net/releases', 'maven.fabricmc.net', 'maven.quiltmc.org/repository/release']) {
    const u = `https://${host}/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar`;
    const c = mirrorCandidates(u);
    assert.ok(c.length >= 2, `${host} 应有镜像`);
    assert.ok(c[1].startsWith('https://bmclapi2.bangbang93.com/maven/'), `${host} 镜像路径错误: ${c[1]}`);
  }
});

test('piston-meta 包 URL 映射为 /version/<id>/json', () => {
  const c = mirrorCandidates('https://piston-meta.mojang.com/v1/packages/75062586b830dd5160f13f1c9130eb365e01f1b9/1.0.json');
  assert.ok(c.includes('https://bmclapi2.bangbang93.com/version/1.0/json'));
});

test('piston-data assets 对象映射为 /assets/<path>', () => {
  const c = mirrorCandidates('https://piston-data.mojang.com/v1/objects/e1f2e0a4b0e0a0e0a0e0a0e0a0e0a0e0a0e0a0e0/icons/grass.png');
  assert.ok(c.includes('https://bmclapi2.bangbang93.com/assets/icons/grass.png'));
});

test('version_manifest_v2 映射正确', () => {
  const c = mirrorCandidates('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  assert.ok(c.includes('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'));
});

test('未知主机无镜像时仅返回原 URL', () => {
  const c = mirrorCandidates('https://example.com/foo.jar');
  assert.deepEqual(c, ['https://example.com/foo.jar']);
});

test('非法 URL 不崩溃', () => {
  assert.deepEqual(mirrorCandidates('not-a-url'), ['not-a-url']);
});

test('bmcl 直链构造函数', () => {
  assert.equal(bmclJarUrl('1.21.11', 'server'), 'https://bmclapi2.bangbang93.com/version/1.21.11/server');
  assert.equal(bmclAssetUrl('indexes/1.21.json'), 'https://bmclapi2.bangbang93.com/assets/indexes/1.21.json');
});

test('候选列表去重且原 URL 优先', () => {
  const c = mirrorCandidates('https://maven.minecraftforge.net/x');
  assert.equal(c[0], 'https://maven.minecraftforge.net/x');
  assert.equal(new Set(c).size, c.length);
});

test('OFFICIAL 常量完整', () => {
  for (const k of ['versionManifest', 'pistonMeta', 'libraries', 'forgeMaven', 'fabricMaven', 'quiltMaven', 'neoforgeMaven']) {
    assert.ok(OFFICIAL[k], `缺少 ${k}`);
  }
});
