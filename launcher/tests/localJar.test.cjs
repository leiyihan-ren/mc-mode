'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const lj = require('../engine/localJar.cjs');

const CLIENTS = path.resolve(__dirname, '../../MC正式版客户端');
const SERVERS = path.resolve(__dirname, '../../MC正式版服务端');
const FIXTURES = path.resolve(__dirname, 'e2e/fixtures');
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-jar-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('真实原版客户端 1.7.10：无 version.json，由文件名推断版本', () => {
  const p = path.join(CLIENTS, '1.7.10.jar');
  const i = lj.inspectJar(p);
  assert.equal(i.kind, lj.KIND.VANILLA_CLIENT);
  assert.equal(i.mainClass, 'net.minecraft.client.Main');
  assert.equal(i.gameVersion, '1.7.10');
  assert.equal(i.signatures, true, '官方 jar 应带 Mojang 签名');
  assert.ok(i.entries > 2000);
});

test('真实原版客户端 1.20.1：读取内嵌 version.json 的 id', () => {
  const i = lj.inspectJar(path.join(CLIENTS, '1.20.1.jar'));
  assert.equal(i.kind, lj.KIND.VANILLA_CLIENT);
  assert.equal(i.gameVersion, '1.20.1');
  assert.equal(i.versionJson.protocol_version, 763);
  assert.equal(i.versionJson.world_version, 3465);
});

test('真实原版客户端 1.21.1 与新快照均可识别', () => {
  assert.equal(lj.inspectJar(path.join(CLIENTS, '1.21.1.jar')).gameVersion, '1.21.1');
  assert.equal(lj.inspectJar(path.join(CLIENTS, '26.1.jar')).gameVersion, '26.1');
});

test('真实原版服务端：旧版 Main-Class 与新版 bundler', () => {
  const old = lj.inspectJar(path.join(SERVERS, '1.10.1.jar'));
  assert.equal(old.kind, lj.KIND.VANILLA_SERVER);
  assert.equal(old.mainClass, 'net.minecraft.server.MinecraftServer');
  assert.equal(old.gameVersion, '1.10.1');
  const bundle = lj.inspectJar(path.join(SERVERS, '1.21.1.jar'));
  assert.equal(bundle.kind, lj.KIND.VANILLA_SERVER);
  assert.equal(bundle.mainClass, 'net.minecraft.bundler.Main');
  assert.ok(bundle.bundlerEntries.some(e => e.includes('server-1.21.1.jar')));
});

test('真实 Fabric Loader 与 NeoForge Installer 识别', () => {
  const f = lj.inspectJar(path.join(FIXTURES, 'fabric-loader-0.20.1.jar'));
  assert.equal(f.kind, lj.KIND.FABRIC_LOADER);
  assert.equal(f.loaderType, 'fabric');
  assert.equal(f.loaderVersion, '0.20.1');
  const n = lj.inspectJar(path.join(FIXTURES, 'neoforge-20.4.253-installer.jar'));
  assert.equal(n.kind, lj.KIND.NEOFORGE_INSTALLER);
  assert.equal(n.hasInstallProfile, true);
  assert.equal(n.gameVersion, '1.20.4', '应读取 version.json.inheritsFrom');
  assert.equal(n.loaderVersion, '20.4.253');
});

test('parseManifest 支持续行，versionFromFilename 提取版本号', () => {
  const m = lj.parseManifest('Manifest-Version: 1.0\r\nMain-Class: net.minecraft.client.Main\r\nLong-Property: abc\r\n  def\r\n\r\n');
  assert.equal(m['Main-Class'], 'net.minecraft.client.Main');
  assert.equal(m['Long-Property'], 'abcdef');
  assert.equal(lj.versionFromFilename('/x/forge-1.20.1-installer.jar'), '1.20.1');
  assert.equal(lj.versionFromFilename('/x/no-version.jar'), null);
});

function makeJar(dest, files) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  z.writeZip(dest);
  return dest;
}

test('buildLocalLaunchPlan：overlay 合并 + 签名丢弃 + natives 抽取 + classpath', (t) => {
  const dir = tmp(t);
  const game = makeJar(path.join(dir, 'game.jar'), {
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nMain-Class: net.minecraft.client.Main\n',
    'version.json': JSON.stringify({ id: '1.7.10', protocol_version: 5 }),
    'net/minecraft/client/Main.class': 'BASECLASS',
    'assets/x.png': 'PNG'
  });
  const installer = makeJar(path.join(dir, 'forge-installer.jar'), {
    'install_profile.json': JSON.stringify({ spec: 0, libraries: [{ name: 'net.minecraftforge:forge:1.7.10' }] }),
    'version.json': JSON.stringify({ id: '1.7.10-forge', inheritsFrom: '1.7.10' }),
    'maven/net/minecraftforge/forge/placeholder.txt': 'placeholder'
  });
  // 真实 installer 结构：universal.jar 放在 maven 路径下
  const zOverlay = new AdmZip();
  zOverlay.addFile('patched.class', Buffer.from('PATCHED'));
  zOverlay.addFile('META-INF/MOJANG.SF', Buffer.from('SIGNATURE'));
  zOverlay.addFile('net/minecraft/client/Main.class', Buffer.from('FORGECLASS'));
  const uni = path.join(dir, 'universal.jar');
  zOverlay.writeZip(uni);
  const installer2 = new AdmZip();
  for (const e of new AdmZip(installer).getEntries()) installer2.addFile(e.entryName, e.getData());
  installer2.addFile('maven/net/minecraftforge/forge/1.7.10/universal.jar', fs.readFileSync(uni));
  installer2.writeZip(installer);

  const nativesJar = makeJar(path.join(dir, 'lwjgl-natives.jar'), {
    'liblwjgl.so': 'NATIVE_SO', 'lwjgl.dll': 'NATIVE_DLL', 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
    'org/lwjgl/LWJGL.class': 'CLASS'
  });
  const plan = lj.buildLocalLaunchPlan({ gameJar: game, loaderJars: [installer], libraries: [nativesJar], outDir: path.join(dir, 'out') });
  assert.equal(plan.kind, lj.KIND.VANILLA_CLIENT);
  assert.equal(plan.gameVersion, '1.7.10');
  assert.equal(plan.merged, true);
  const merged = new AdmZip(plan.gameJar);
  assert.equal(merged.readFile(merged.getEntry('patched.class')).toString(), 'PATCHED');
  assert.equal(merged.readFile(merged.getEntry('net/minecraft/client/Main.class')).toString(), 'FORGECLASS', 'overlay 应覆盖同名类');
  assert.equal(merged.getEntry('META-INF/MOJANG.SF'), null, 'overlay 签名必须丢弃');
  assert.equal(plan.natives.length, 2);
  assert.ok(plan.natives.some(p => p.endsWith('liblwjgl.so')));
  assert.equal(fs.readFileSync(path.join(plan.nativesDir, 'lwjgl.dll'), 'utf8'), 'NATIVE_DLL');
  assert.ok(plan.jvmArgs.includes('-Djava.library.path=' + plan.nativesDir));
  assert.ok(plan.classpath.includes(nativesJar));
  assert.ok(plan.classpath[plan.classpath.length - 1].endsWith('merged-game.jar'));
  assert.ok(plan.warnings.some(w => w.includes('丢弃签名')));
});

test('把服务端 Jar 当作游戏客户端会被拒绝', () => {
  assert.throws(() => lj.buildLocalLaunchPlan({
    gameJar: path.join(SERVERS, '1.10.1.jar'), outDir: os.tmpdir()
  }), /不是原版客户端/);
});

test('损坏的 Jar 给出明确错误', (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'broken.jar');
  fs.writeFileSync(p, 'NOT A ZIP');
  assert.throws(() => lj.inspectJar(p), /不是有效的 Jar/);
});
