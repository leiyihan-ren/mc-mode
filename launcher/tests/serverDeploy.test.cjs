'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectJarKind, deployServer, deployVanillaServer, generateStartScripts, writeEula, mavenPathOf, loaderVersionOf, JAR_KINDS
} = require('../engine/serverDeploy');

const LOADERS = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d56-08153a6a8000/模组加载器';
const SERVER_JAR = '/workspace/MC正式版服务端/1.21.11.jar';

function findLoader(prefix) {
  for (const d of fs.readdirSync(LOADERS)) {
    const full = path.join(LOADERS, d);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) if (f.startsWith(prefix)) return path.join(full, f);
  }
  return null;
}

test('识别: 真实原版服务端 jar', () => {
  assert.equal(detectJarKind(SERVER_JAR), JAR_KINDS.VANILLA);
});

test('识别: 真实 NeoForge installer', () => {
  const p = findLoader('neoforge-');
  assert.ok(p);
  assert.equal(detectJarKind(p), JAR_KINDS.NEOFORGE);
});

test('识别: 真实旧版 Forge installer', () => {
  const p = findLoader('forge-1.10.2');
  assert.ok(p);
  assert.equal(detectJarKind(p), JAR_KINDS.FORGE);
});

test('识别: Fabric loader jar -> fabric-server', () => {
  const p = findLoader('fabric-loader-');
  assert.ok(p);
  assert.equal(detectJarKind(p), JAR_KINDS.FABRIC);
});

test('识别: Quilt loader jar -> quilt-server', () => {
  const p = findLoader('quilt-loader-');
  assert.ok(p);
  assert.equal(detectJarKind(p), JAR_KINDS.QUILT);
});

test('识别: 未知 jar', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-kind-'));
  const p = path.join(d, 'weird.jar');
  fs.writeFileSync(p, 'garbage');
  assert.equal(detectJarKind(p), JAR_KINDS.UNKNOWN);
});

test('生成启动脚本: 内容与权限', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-script-'));
  const r = generateStartScripts(d, { coreJar: 'server.jar', memory: '6G' });
  const sh = fs.readFileSync(r.sh, 'utf8');
  const bat = fs.readFileSync(r.bat, 'utf8');
  assert.ok(sh.includes('-Xmx6G'), 'sh 应含内存参数');
  assert.ok(sh.includes('-jar server.jar'));
  assert.ok(bat.includes('-Xmx6G'));
  assert.ok((fs.statSync(r.sh).mode & 0o777) === 0o755, 'sh 应可执行');
});

test('eula 写入', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-eula-'));
  const p = writeEula(d);
  assert.equal(fs.readFileSync(p, 'utf8').includes('eula=true'), true);
});

test('部署: 原版服务端完整流程', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-deploy-'));
  const r = deployVanillaServer(SERVER_JAR, d, { memory: '4G' });
  assert.equal(r.kind, JAR_KINDS.VANILLA);
  assert.ok(fs.existsSync(r.coreJar) && fs.statSync(r.coreJar).size > 1000000, 'server.jar 应存在');
  assert.equal(fs.readFileSync(r.eula, 'utf8').includes('eula=true'), true);
  assert.ok(fs.existsSync(r.scripts.sh) && fs.existsSync(r.scripts.bat));
});

test('部署入口: 自动路由到正确处理器', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-deploy2-'));
  const r = await deployServer(SERVER_JAR, d);
  assert.equal(r.kind, JAR_KINDS.VANILLA);
  await assert.rejects(() => deployServer('/nonexistent.jar', d), /无法识别|无法打开/);
});

test('部署: Fabric 服务端（loader jar + properties）', async () => {
  const loaderJar = findLoader('fabric-loader-');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-deploy3-'));
  // 模拟 server.jar 已存在
  fs.copyFileSync(SERVER_JAR, path.join(d, 'server.jar'));
  const r = await deployServer(loaderJar, d, {});
  assert.equal(r.kind, JAR_KINDS.FABRIC);
  assert.ok(fs.existsSync(r.coreJar), 'fabric-server-launcher.jar 应存在');
  assert.equal(fs.readFileSync(path.join(d, 'fabric-server-launcher.properties'), 'utf8'), 'serverJar=server.jar\n');
  assert.equal(fs.readFileSync(r.eula, 'utf8').includes('eula=true'), true);
});

test('mavenPathOf: 标准坐标', () => {
  assert.equal(mavenPathOf('org.ow2.asm:asm:9.10.1'), 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.equal(mavenPathOf('com.mojang:logging:1.1.1'), 'com/mojang/logging/1.1.1/logging-1.1.1.jar');
});

test('mavenPathOf: classifier 与 @ext（installer data 风格）', () => {
  assert.equal(mavenPathOf('net.minecraft:client:1.20.4:slim'), 'net/minecraft/client/1.20.4/client-1.20.4-slim.jar');
  assert.equal(mavenPathOf('net.neoforged:neoform:1.20.4:mappings-merged@txt'), 'net/neoforged/neoform/1.20.4/neoform-1.20.4-mappings-merged.txt');
  assert.equal(mavenPathOf('net.fabricmc:sponge-mixin:0.17.5+mixin.0.8.7'), 'net/fabricmc/sponge-mixin/0.17.5+mixin.0.8.7/sponge-mixin-0.17.5+mixin.0.8.7.jar');
  assert.equal(mavenPathOf('bad-coords'), null);
});

test('loaderVersionOf: 从 jar 文件名解析', () => {
  const { loaderVersionOf } = require('../engine/serverDeploy');
  assert.equal(loaderVersionOf('/x/fabric-loader-0.20.1.jar'), '0.20.1');
  assert.equal(loaderVersionOf('/x/fabric-loader-0.14.25.jar'), '0.14.25');
  assert.equal(loaderVersionOf('/x/other.jar'), null);
});
