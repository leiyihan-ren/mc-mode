'use strict';
/**
 * 【0.7.0 模块二】PC 端深度适配：Java 环境体检 / 内存防崩 / Natives 中文空格路径
 * 全部断言基于真实逻辑与真实文件系统，网络与 Electron 依赖均注入 stub。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const P = require('../engine/preflight.cjs');
const J = require('../engine/jvmArgs.js');

const GB = 1024 * 1024 * 1024;
const javaList = [
  { recognized: true, major: 8, version: '1.8.0_301', path: '/jdk8/bin/java', source: 'system' },
  { recognized: true, major: 17, version: '17.0.9', path: '/jdk17/bin/java', source: 'system' },
  { recognized: true, major: 21, version: '21.0.1', path: '/jdk21/bin/java', source: 'system' }
];
const verOutput = (v) => () => ({ stdout: '', stderr: `openjdk version "${v}" 2023-10-17`, status: 0 });

// ==================== 1. 内存解析与防崩 ====================
test('parseMemoryMb：G/M/小数/纯数字/非法值', () => {
  assert.equal(P.parseMemoryMb('4G'), 4096);
  assert.equal(P.parseMemoryMb('4096M'), 4096);
  assert.equal(P.parseMemoryMb('1.5G'), 1536);
  assert.equal(P.parseMemoryMb('512m'), 512);
  assert.equal(P.parseMemoryMb('2048'), 2048);
  assert.equal(P.parseMemoryMb(2048), 2048);
  assert.equal(P.parseMemoryMb('??'), null);
  assert.equal(P.parseMemoryMb(null), null);
  assert.equal(P.parseMemoryMb('0G'), null);
});

test('fmtMb 人类可读', () => {
  assert.equal(P.fmtMb(512), '512M');
  assert.equal(P.fmtMb(4096), '4G');
  assert.equal(P.fmtMb(6144), '6G');
});

test('内存防崩：-Xmx 低于 1024MB 直接拦截', () => {
  const r = P.checkMemory({ minMemory: '256M', maxMemory: '512M', totalMemBytes: 8 * GB });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'MEM_TOO_LOW');
  assert.equal(r.issues[0].level, 'block');
  assert.match(r.issues[0].fix, /1024MB/);
});

test('内存防崩：-Xmx 超过物理内存直接拦截', () => {
  const r = P.checkMemory({ minMemory: '1G', maxMemory: '64G', totalMemBytes: 8 * GB });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'MEM_EXCEED_PHYSICAL');
  assert.match(r.issues[0].message, /超过物理内存/);
});

test('内存防崩：Xms > Xmx 拦截；正常 4G / 8G 通过', () => {
  const bad = P.checkMemory({ minMemory: '4G', maxMemory: '2G', totalMemBytes: 8 * GB });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some(i => i.code === 'MIN_GT_MAX'));
  const ok = P.checkMemory({ minMemory: '1G', maxMemory: '4G', totalMemBytes: 8 * GB });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.issues, []);
});

test('内存防崩：占用物理内存 85% 以上给出预警但不拦截', () => {
  const r = P.checkMemory({ minMemory: '1G', maxMemory: '7680M', totalMemBytes: 8 * GB });
  assert.equal(r.ok, true);
  assert.equal(r.issues[0].level, 'warn');
  assert.equal(r.issues[0].code, 'MEM_TIGHT');
});

test('内存防崩：无法识别的内存值拦截并给出写法提示', () => {
  const r = P.checkMemory({ minMemory: '1G', maxMemory: 'abc', totalMemBytes: 8 * GB });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'MEM_INVALID');
});

// ==================== 2. Java 环境扫描与自动接管 ====================
test('detectJavaMajor 真实解析 java -version，失败返回 null 不猜', () => {
  assert.equal(P.detectJavaMajor('/x', verOutput('17.0.9')), 17);
  assert.equal(P.detectJavaMajor('/x', verOutput('1.8.0_301')), 8);
  assert.equal(P.detectJavaMajor('/x', () => ({ stdout: '', stderr: 'garbage' })), null);
  assert.equal(P.detectJavaMajor('/x', () => { throw new Error('ENOENT'); }), null);
  assert.equal(P.detectJavaMajor('/x', null), null);
});

test('1.20.1 需要 Java 17：未指定路径时自动挑选精确匹配', () => {
  const r = P.checkJava({ mcVersion: '1.20.1', list: javaList, spawnSync: null });
  assert.equal(r.ok, true);
  assert.equal(r.required.java, 17);
  assert.equal(r.resolvedPath, '/jdk17/bin/java');
  assert.deepEqual(r.issues, []);
});

test('指定的 Java 8 过低时自动接管到 Java 17，并给出可读提示', () => {
  const r = P.checkJava({
    mcVersion: '1.20.1', javaPath: '/jdk8/bin/java', list: javaList,
    exists: () => true, spawnSync: verOutput('1.8.0_301')
  });
  assert.equal(r.ok, true);
  assert.equal(r.resolvedPath, '/jdk17/bin/java');
  assert.equal(r.issues[0].code, 'JAVA_AUTOFIX');
  assert.match(r.issues[0].message, /已自动切换到/);
});

test('本机缺少所需 Java 时拦截，并明确指向 Java 管家修复', () => {
  const r = P.checkJava({ mcVersion: '1.20.1', list: [javaList[0]], spawnSync: null });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'JAVA_MISSING');
  assert.match(r.issues[0].message, /Java 8/);
  assert.match(r.issues[0].fix, /Java 管家/);
});

test('指定 Java 版本过高给出 Forge 兼容预警但不拦截', () => {
  const r = P.checkJava({
    mcVersion: '1.20.1', javaPath: '/jdk21/bin/java', list: javaList,
    exists: () => true, spawnSync: verOutput('21.0.1')
  });
  assert.equal(r.ok, true);
  assert.equal(r.resolvedPath, '/jdk21/bin/java');
  assert.equal(r.issues[0].code, 'JAVA_NEWER');
  assert.equal(r.issues[0].level, 'warn');
});

test('指定的 Java 路径不存在时拦截；MC 版本无法识别时拦截', () => {
  const missing = P.checkJava({
    mcVersion: '1.20.1', javaPath: '/nope/java', list: javaList,
    exists: () => false, spawnSync: null
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.issues[0].code, 'JAVA_MISSING');
  const unknown = P.checkJava({ mcVersion: 'garbage', list: [], spawnSync: null });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.issues[0].code, 'MC_VERSION_UNKNOWN');
});

test('本地 Java 扫描带 TTL 缓存：连续调用只真实扫描一次（启动提速）', () => {
  P.resetScanCache();
  let calls = 0;
  const scanFn = () => { calls++; return { list: javaList }; };
  const a = P.cachedLocalJava(30000, scanFn);
  const b = P.cachedLocalJava(30000, scanFn);
  assert.equal(calls, 1, '第二次应命中缓存');
  assert.strictEqual(a, b);
  P.resetScanCache();
  P.cachedLocalJava(30000, scanFn);
  assert.equal(calls, 2, 'reset 后应重新扫描');
  P.resetScanCache();
});

// ==================== 3. Natives 中文 / 空格路径 ====================
test('probeNativesDir 在含中文与空格的真实目录读写成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext 中文 空格 '));
  try {
    const target = path.join(dir, 'natives 子目录 中文');
    const r = P.probeNativesDir(target);
    assert.equal(r.ok, true);
    assert.equal(r.probed, true);
    assert.ok(fs.existsSync(target), '探针应创建目录');
    assert.equal(fs.readdirSync(target).length, 0, '临时标记文件应被清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkNatives 在写入失败时拦截并给出可执行的修复建议', () => {
  const r = P.checkNatives({
    nativesDir: '/some/中文 路径/natives',
    probe: () => ({ ok: false, probed: true, error: 'EACCES: permission denied' })
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'NATIVES_PATH');
  assert.match(r.issues[0].fix, /纯英文、无空格/);
});

test('extractNatives 在「中文 + 空格」路径下真实解压成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext 中文 空格 '));
  try {
    const libRoot = path.join(dir, 'libraries 仓库');
    const nativesDir = path.join(dir, 'natives 输出 中文');
    const rel = 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar';
    const jarPath = path.join(libRoot, rel);
    fs.mkdirSync(path.dirname(jarPath), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('liblwjgl.so', Buffer.from('ELF-FAKE-NATIVE'));
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0'));
    zip.writeZip(jarPath);

    const vj = {
      libraries: [{
        name: 'org.lwjgl:lwjgl:3.3.1:natives-linux',
        natives: { linux: 'natives-linux' },
        downloads: { artifact: { path: rel } }
      }]
    };
    const r = J.extractNatives(vj, nativesDir, { os: 'linux', arch: 'x86_64' }, { libRoot });
    assert.equal(r.extracted, 1, `实际解压 ${r.extracted}`);
    assert.equal(r.rejected, 0);
    assert.equal(r.dir, path.resolve(nativesDir));
    assert.equal(fs.readFileSync(path.join(nativesDir, 'liblwjgl.so'), 'utf8'), 'ELF-FAKE-NATIVE');
    assert.equal(fs.existsSync(path.join(nativesDir, 'META-INF')), false, 'META-INF 应跳过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zip-Slip 条目被拒绝，绝不写出目标目录之外', () => {
  assert.equal(J.isUnsafeZipEntry('../../evil.so'), true);
  assert.equal(J.isUnsafeZipEntry('a/../b/../../evil.so'), true);
  assert.equal(J.isUnsafeZipEntry('C:\\Windows\\evil.dll'), true);
  assert.equal(J.isUnsafeZipEntry('/absolute/evil.so'), false); // 前导斜杠会被归一化去掉
  assert.equal(J.isUnsafeZipEntry('natives/libfoo.so'), false);
  assert.equal(J.isInsideDir('/a/b', '/a/b/c.so'), true);
  assert.equal(J.isInsideDir('/a/b', '/a/evil.so'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext zip 空格 '));
  try {
    const libRoot = path.join(dir, 'lib');
    const nativesDir = path.join(dir, 'natives 中文');
    const rel = 'x/natives.jar';
    const jarPath = path.join(libRoot, rel);
    fs.mkdirSync(path.dirname(jarPath), { recursive: true });
    // AdmZip.addFile 会把 ../ 规范化掉，无法构造真实恶意条目；
    // 改用 Python zipfile 写入保留 '..' 的 jar，做端到端 Zip-Slip 防护验证。
    cp.execFileSync('python3.11', ['-c',
      "import zipfile,sys\n" +
      "with zipfile.ZipFile(sys.argv[1],'w') as z:\n" +
      "    z.writestr('good.so','OK')\n" +
      "    z.writestr('../../escaped.so','EVIL')\n",
      jarPath]);
    const vj = {
      libraries: [{
        name: 'x:natives:1:natives-linux',
        natives: { linux: 'natives-linux' },
        downloads: { artifact: { path: rel } }
      }]
    };
    const r = J.extractNatives(vj, nativesDir, { os: 'linux' }, { libRoot });
    assert.equal(r.extracted, 1);
    assert.ok(r.rejected >= 1, '恶意条目应被拒绝');
    assert.equal(fs.existsSync(path.join(dir, 'escaped.so')), false, '不得逃逸到目录外');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 4. 汇总与启动链接线 ====================
test('runPreflight 汇总 blocking / warnings / resolvedJavaPath / 可读 summary', () => {
  const r = P.runPreflight({
    mcVersion: '1.20.1', javaPath: '/jdk8/bin/java', list: javaList,
    exists: () => true, spawnSync: verOutput('1.8.0_301'),
    minMemory: '1G', maxMemory: '4G', totalMemBytes: 8 * GB,
    skipNatives: true
  });
  assert.equal(r.ok, true);
  assert.equal(r.resolvedJavaPath, '/jdk17/bin/java');
  assert.equal(r.warnings.length, 1);
  assert.match(r.summary, /启动前检查通过/);
  assert.ok(r.java && r.memory && r.natives === null);
});

test('runPreflight 任一致命问题即整体拦截，summary 合并全部原因', () => {
  const r = P.runPreflight({
    mcVersion: '1.20.1', list: [javaList[0]], spawnSync: null,
    minMemory: '256M', maxMemory: '64G', totalMemBytes: 8 * GB,
    skipNatives: true
  });
  assert.equal(r.ok, false);
  assert.ok(r.blocking.length >= 2);
  assert.match(r.summary, /启动前检查未通过/);
  assert.ok(r.issues.some(i => i.code === 'JAVA_MISSING'));
  assert.ok(r.issues.some(i => i.code === 'MEM_EXCEED_PHYSICAL'));
});

test('launchGameCore 把体检排在补齐依赖之前，并透传结构化拦截结果', () => {
  const s = fs.readFileSync(path.join(ROOT, 'electron/ipc.cjs'), 'utf8');
  const iPf = s.indexOf('preflight.runPreflight');
  const iDl = s.indexOf('downloadFile(m.url');
  assert.ok(iPf > 0, '未接入 preflight');
  assert.ok(iDl > iPf, '体检必须早于依赖下载，才能零网络快速失败');
  assert.match(s, /error: pf\.summary/);
  assert.match(s, /preflight: \{ java: pf\.java/);
});

test('IPC 集成：内存非法时 game:launch 快速拦截，不启动 JVM', async () => {
  const registry = new Map();
  const original = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: (ch, cb) => { registry.set(ch, cb); return cb; } },
        dialog: { showOpenDialog: async () => ({ canceled: true }) },
        shell: { openExternal: async () => {} }
      };
    }
    return original.apply(this, arguments);
  };
  try {
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(null);
    const r = await ipc.dispatchChannel('game:launch', {
      versionId: '1.20.1',
      versionJson: { libraries: [], mainClass: 'net.minecraft.client.main.Main' },
      minMemory: '256M', maxMemory: '512M',
      javaPath: '/definitely/missing/java'
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /启动前检查未通过/);
    assert.match(r.error, /低于 1024MB/);
    assert.ok(r.issues.some(i => i.code === 'MEM_TOO_LOW'));
    assert.ok(r.preflight && r.preflight.memory);
  } finally {
    Module._load = original;
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/electron/ipc.cjs') || k.includes('/electron/remoteControl.cjs')) delete require.cache[k];
    }
  }
});
