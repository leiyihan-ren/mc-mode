'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  readLauncherVersionJson, readInstallProfile, readGameMetadata,
  extractMeta, parseMavenCoords, mavenPathFromCoords, normalizeLibrary, detectLoader
} = require('../engine/versionJson');

const CLIENT_JAR = '/workspace/MC正式版客户端/1.21.11.jar';
const SERVER_JAR = '/workspace/MC正式版服务端/1.21.11.jar';
const LOADERS = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d56-08153a6a8000/模组加载器';

/** 在本地加载器目录找一个样本 */
function findLoader(prefix) {
  for (const d of fs.readdirSync(LOADERS)) {
    const dir = path.join(LOADERS, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix)) return path.join(dir, f);
    }
  }
  return null;
}

/** 合成测试 jar：inheritsFrom + libraries + rules + modern arguments */
function makeSyntheticJar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-vj-'));
  const p = path.join(dir, 'synthetic.jar');
  const zip = new AdmZip();
  zip.addFile('version.json', Buffer.from(JSON.stringify({
    id: '1.20.1-forge-47.1.106',
    inheritsFrom: '1.20.1',
    mainClass: 'net.minecraftforge.bootstrap.ForgeBootstrap',
    javaVersion: { component: 'jre-legacy', majorVersion: 17 },
    assetIndex: { id: '1.20.1', url: 'https://piston-data.mojang.com/v1/objects/abc/indexes/1.20.1.json', sha1: 'abc', totalSize: 100 },
    assets: 'legacy',
    libraries: [
      { name: 'net.minecraftforge:forge:1.20.1-47.1.106:client', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-client.jar', url: 'https://maven.minecraftforge.net/x.jar', sha1: 'd'.repeat(40), size: 123 } }, clientreq: true },
      { name: 'cpw.mods:securejarhandler:1.0.8' },
      { name: 'org.ow2.asm:asm:9.5', rules: [{ action: 'allow', os: { name: 'osx', arch: 'x86' } }] },
      { name: 'net.minecraft:client:1.20.1', rules: [{ action: 'allow' }] }
    ],
    arguments: { game: ['--quickPlaySingleplayer', 'World'], jvm: ['-Dfoo=bar'] }
  })));
  zip.writeZip(p);
  return p;
}

test('真实原版客户端 jar: 游戏元数据可读，启动器定义不存在', () => {
  assert.ok(fs.existsSync(CLIENT_JAR), '缺少测试样本客户端 jar');
  const meta = readGameMetadata(CLIENT_JAR);
  assert.ok(meta, '应读到游戏内部元数据');
  assert.equal(meta.id, '1.21.11');
  assert.equal(typeof meta.protocolVersion, 'number');
  assert.ok(meta.packVersion, '应有 pack_version');
  assert.equal(readLauncherVersionJson(CLIENT_JAR), null, '原版 jar 不应含启动器版本定义');
});

test('真实原版服务端 jar: 同上', () => {
  assert.ok(fs.existsSync(SERVER_JAR), '缺少测试样本服务端 jar');
  const meta = readGameMetadata(SERVER_JAR);
  assert.equal(meta.id, '1.21.11');
  assert.equal(readLauncherVersionJson(SERVER_JAR), null);
});

test('真实 NeoForge installer: version.json 即启动器定义', () => {
  const p = findLoader('neoforge-');
  assert.ok(p, '缺少 NeoForge 样本');
  const vj = readLauncherVersionJson(p);
  assert.ok(vj, 'NeoForge installer 应含启动器版本定义');
  const m = extractMeta(vj);
  assert.equal(m.loader, 'neoforge');
  assert.equal(m.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
  assert.ok(m.inheritsFrom, '应有 inheritsFrom');
  assert.ok(m.libraries.length > 20, `NeoForge 依赖应很多, 实际 ${m.libraries.length}`);
  // install_profile 也应可读（服务端部署需要）
  const ip = readInstallProfile(p);
  assert.ok(ip && ip.processors !== undefined || (ip && ip.data !== undefined), 'install_profile 应可读');
});

test('真实 Forge installer(旧版): install_profile.versionInfo 提取', () => {
  const p = findLoader('forge-1.10.2');
  assert.ok(p, '缺少 Forge 1.10.2 样本');
  const vj = readLauncherVersionJson(p);
  assert.ok(vj, '旧版 Forge 应从 install_profile.versionInfo 提取');
  const m = extractMeta(vj);
  assert.equal(m.loader, 'forge');
  assert.ok(m.mainClass, '应有 mainClass');
  const ip = readInstallProfile(p);
  assert.ok(ip, 'install_profile 应可读');
  assert.ok(ip.versionInfo, '旧版 install_profile 应含 versionInfo');
});

test('合成 jar: inheritsFrom/loader 识别/rules/clientreq', () => {
  const meta = extractMeta(readLauncherVersionJson(makeSyntheticJar()));
  assert.equal(meta.inheritsFrom, '1.20.1');
  assert.equal(meta.loader, 'forge');
  assert.equal(meta.mainClass, 'net.minecraftforge.bootstrap.ForgeBootstrap');
  assert.equal(meta.javaVersion.majorVersion, 17);
  assert.equal(meta.assetIndex.id, '1.20.1');
  const forge = meta.libraries.find(l => l.artifact === 'forge');
  assert.equal(forge.clientreq, true);
  assert.equal(forge.classifier, 'client');
  const asm = meta.libraries.find(l => l.artifact === 'asm');
  assert.ok(Array.isArray(asm.rules) && asm.rules.length === 1);
  assert.equal(mavenPathFromCoords(asm), 'org/ow2/asm/asm/9.5/asm-9.5.jar');
  assert.deepEqual(meta.argumentsGame, ['--quickPlaySingleplayer', 'World']);
  assert.deepEqual(meta.argumentsJvm, ['-Dfoo=bar']);
});

test('无任何版本定义返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-vj2-'));
  const p = path.join(dir, 'empty.jar');
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'));
  zip.writeZip(p);
  assert.equal(readLauncherVersionJson(p), null);
  assert.equal(readGameMetadata(p), null);
});

test('损坏文件抛清晰错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-vj3-'));
  const p = path.join(dir, 'bad.jar');
  fs.writeFileSync(p, 'not a zip file at all');
  assert.throws(() => readLauncherVersionJson(p), /无法打开 jar/);
});

test('Maven 坐标解析边界', () => {
  const c = parseMavenCoords('net.minecraftforge:forge:1.20.1-47.1.106:installer');
  assert.equal(c.group, 'net.minecraftforge');
  assert.equal(c.classifier, 'installer');
  const c2 = parseMavenCoords('cpw.mods:securejarhandler:1.0.8');
  assert.equal(c2.classifier, null);
  const c3 = parseMavenCoords('weird');
  assert.equal(c3.artifact, 'weird');
});

test('detectLoader 分类（含 mainClass 兜底）', () => {
  assert.equal(detectLoader([{ raw: 'net.fabricmc:fabric-loader:0.16.0' }], null), 'fabric');
  assert.equal(detectLoader([{ raw: 'org.quiltmc:quilt-loader:0.24.0' }], null), 'quilt');
  assert.equal(detectLoader([{ raw: 'net.neoforged:neoforge:21.1.0' }], null), 'neoforge');
  assert.equal(detectLoader([{ raw: 'net.minecraftforge:forge:47.1.0' }], null), 'forge');
  assert.equal(detectLoader([{ raw: 'com.mojang:brigadier:1.0.18' }], null), 'vanilla');
  assert.equal(detectLoader([], 'net.fabricmc.loader.impl.launch.knot.KnotServer'), 'fabric');
  assert.equal(detectLoader([], 'cpw.mods.bootstraplauncher.BootstrapLauncher'), 'neoforge');
  assert.equal(detectLoader([], 'net.minecraftforge.fmlserverlauncher.FmlServerLauncher'), 'forge');
});

test('normalizeLibrary 字符串形式补全 path', () => {
  const l = normalizeLibrary('com.mojang:blocklist:1.0.10');
  assert.equal(l.group, 'com.mojang');
  assert.equal(l.path, 'com/mojang/blocklist/1.0.10/blocklist-1.0.10.jar');
  assert.equal(normalizeLibrary(null), null);
  assert.equal(normalizeLibrary({}), null);
});
