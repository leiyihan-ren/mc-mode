'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildJvmArgs, substitute, extractNatives } = require('../engine/jvmArgs');

const LINUX = { os: 'linux', arch: 'x64', features: {} };

const MODERN_VJ = {
  id: '1.21.11',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: {
    jvm: [
      '-Djava.library.path=${natives_directory}',
      '-Djna.library.path=${natives_directory}',
      { rules: [{ action: 'allow', os: { name: 'osx', arch: 'x86' } }], value: ['-XstartOnFirstThread'] },
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-Xss2M'] },
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp', '${classpath}'
    ],
    game: [
      '--username', '${auth_player_name}',
      '--version', '${version_name}',
      '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}',
      '--assetIndex', '${assets_index_name}',
      '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}',
      '--userType', '${user_type}',
      '--versionType', '${version_type}'
    ]
  }
};

const LEGACY_VJ = {
  id: '1.6.4',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties}'
};

const CTX = {
  classpath: '/libs/a.jar:/libs/b.jar:/games/client.jar',
  nativesDir: '/natives',
  gameDir: '/game',
  assetsDir: '/assets',
  assetIndexId: '29',
  playerName: 'Steve',
  uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
  versionId: '1.21.11',
  versionType: 'release',
  minMemory: '512M',
  maxMemory: '4G',
  env: LINUX
};

test('substitute 占位符替换', () => {
  assert.equal(substitute('${classpath}', { classpath: 'a:b' }), 'a:b');
  assert.equal(substitute('${unknown}', {}), '${unknown}', '未知占位符原样保留');
});

test('现代格式 JVM 参数: 内存/库路径/规则过滤/占位符', () => {
  const { jvmArgs, gameArgs } = buildJvmArgs(MODERN_VJ, CTX);
  assert.ok(jvmArgs.includes('-Xms512M'));
  assert.ok(jvmArgs.includes('-Xmx4G'));
  assert.ok(jvmArgs.includes('-Djava.library.path=/natives'));
  assert.ok(jvmArgs.includes('-Dminecraft.launcher.brand=MC-Next'));
  assert.ok(jvmArgs.includes('-cp'));
  assert.equal(jvmArgs[jvmArgs.indexOf('-cp') + 1], '/libs/a.jar:/libs/b.jar:/games/client.jar');
  // osx 规则参数在 linux 环境应被过滤
  assert.ok(!jvmArgs.includes('-XstartOnFirstThread'), 'osx-x86 参数应被过滤');
  assert.ok(!jvmArgs.includes('-Xss2M'), 'osx 参数应被过滤');
  // 游戏参数占位符全部替换
  assert.ok(gameArgs.includes('--username'));
  assert.equal(gameArgs[gameArgs.indexOf('--username') + 1], 'Steve');
  assert.equal(gameArgs[gameArgs.indexOf('--gameDir') + 1], '/game');
  assert.equal(gameArgs[gameArgs.indexOf('--versionType') + 1], 'release');
  assert.ok(!gameArgs.some(a => a.includes('${')), '不应残留占位符');
});

test('macOS 环境包含 -XstartOnFirstThread', () => {
  const { jvmArgs } = buildJvmArgs(MODERN_VJ, { ...CTX, env: { os: 'osx', arch: 'x86', features: {} } });
  assert.ok(jvmArgs.includes('-XstartOnFirstThread'));
});

test('旧版 minecraftArguments 字符串格式', () => {
  const { gameArgs } = buildJvmArgs(LEGACY_VJ, CTX);
  assert.ok(gameArgs.includes('--username'));
  assert.equal(gameArgs[gameArgs.indexOf('--username') + 1], 'Steve');
  assert.equal(gameArgs[gameArgs.indexOf('--session') + 1], 'offline');
  assert.ok(!gameArgs.some(a => a.includes('${')), '不应残留占位符');
});

test('extraJvmArgs 优先级最高（置前）', () => {
  const { jvmArgs } = buildJvmArgs(MODERN_VJ, { ...CTX, extraJvmArgs: ['-XX:+UseG1GC', '-Dfile.encoding=UTF-8'] });
  assert.equal(jvmArgs[0], '-XX:+UseG1GC');
  assert.equal(jvmArgs[1], '-Dfile.encoding=UTF-8');
});

test('无内存参数时不生成 -Xmx', () => {
  const { jvmArgs } = buildJvmArgs(MODERN_VJ, { ...CTX, minMemory: null, maxMemory: null });
  assert.ok(!jvmArgs.some(a => a.startsWith('-Xmx')));
  assert.ok(!jvmArgs.some(a => a.startsWith('-Xms')));
});

test('extractNatives: 解压非 META-INF 条目', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-natives-'));
  const libsDir = path.join(d, 'libraries');
  const nativesDir = path.join(d, 'natives');
  // 构造假 natives jar
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addFile('liblwjgl.so', Buffer.from('ELF-BINARY'));
  z.addFile('libglfw.so', Buffer.from('ELF2'));
  z.addFile('META-INF/MANIFEST.MF', Buffer.from('x'));
  const rel = 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar';
  fs.mkdirSync(path.dirname(path.join(libsDir, rel)), { recursive: true });
  z.writeZip(path.join(libsDir, rel));

  const vj = { libraries: [{ name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] }] };
  const r = extractNatives(vj, nativesDir, LINUX);
  assert.equal(r.extracted, 2, '应解压 2 个 so');
  assert.ok(fs.existsSync(path.join(nativesDir, 'liblwjgl.so')));
  assert.ok(!fs.existsSync(path.join(nativesDir, 'META-INF')), 'META-INF 应跳过');
});

test('extractNatives: 缺失 jar 只跳过不崩溃', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-natives2-'));
  const vj = { libraries: [{ name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] }] };
  const r = extractNatives(vj, path.join(d, 'natives'), LINUX);
  assert.equal(r.extracted, 0);
  assert.equal(r.skipped, 1);
});
