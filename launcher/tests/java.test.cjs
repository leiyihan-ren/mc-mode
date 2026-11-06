'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const J = require('../engine/java/manager.cjs');

const resp = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

test('MC 版本 → Java 主版本映射（官方规则边界）', () => {
  const cases = [
    ['1.7.10', 8], ['1.12.2', 8], ['1.16.5', 8],
    ['1.17', 16], ['1.17.1', 16],
    ['1.18', 17], ['1.19.2', 17], ['1.20.1', 17], ['1.20.4', 17],
    ['1.20.5', 21], ['1.21', 21], ['1.21.1', 21], ['26.1', 21], ['24w14a', 21]
  ];
  for (const [v, java] of cases) assert.equal(J.requiredJava(v).java, java, `${v} 应需要 Java ${java}`);
  assert.equal(J.requiredJava('乱写').java, null);
  assert.equal(J.requiredJava('').java, null);
});

test('版本比较：1.20.5 > 1.20.4，1.21 > 1.20.5，快照归入最新', () => {
  assert.ok(J.compareMc('1.20.5', '1.20.4') > 0);
  assert.ok(J.compareMc('1.21', '1.20.5') > 0);
  assert.ok(J.compareMc('1.16.5', '1.17') < 0);
  assert.equal(J.compareMc('1.20.1', '1.20.1'), 0);
  assert.equal(J.requiredJava('24w14a').snapshot, true);
});

test('release 文件 / java -version 输出解析主版本', () => {
  assert.deepEqual(
    { ...J.parseReleaseFile('JAVA_VERSION="17.0.21"\nIMPLEMENTOR="Eclipse Adoptium"\nOS_ARCH="x86_64"') },
    { version: '17.0.21', major: 17, vendor: 'Eclipse Adoptium', arch: 'x86_64', runtimeName: null }
  );
  assert.equal(J.majorOf('1.8.0_301'), 8);
  assert.equal(J.majorOf('20.0.1'), 20);
  assert.equal(J.parseVersionOutput('openjdk version "20.0.1" 2023-03-21\nOpenJDK Runtime Environment Zulu20.28').major, 20);
  assert.equal(J.parseVersionOutput('java version "1.8.0_301"').major, 8);
});

test('扫描本地 JDK：自定义目录 + 去重 + 按主版本排序', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-java-'));
  const mk = (name, version) => {
    const home = path.join(tmp, name);
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'java'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${version}"\nIMPLEMENTOR="Eclipse Adoptium"\n`);
    return home;
  };
  mk('jdk8', '1.8.0_412');
  mk('jdk17', '17.0.21');
  mk('jdk21', '21.0.2');
  const r = J.scanLocalJava({ extraRoots: [tmp], env: { PATH: '', JAVA_HOME: '', JDK_HOME: '' }, home: tmp, io: { realpath: p => p } });
  const majors = r.list.map(x => x.major);
  assert.deepEqual(majors, [8, 17, 21]);
  assert.ok(r.list.every(x => x.recognized));
  assert.equal(r.list[0].vendor, 'Eclipse Adoptium');
  assert.ok(r.scanned.includes(tmp));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('选择 Java：精确优先、更高版本带兼容性警告、过旧则报缺失', () => {
  const L = [8, 17, 21].map(major => ({ major, recognized: true, version: `${major}.0`, path: `/j${major}/bin/java`, source: 'local' }));
  const a = J.selectJava(L, '1.20.1');
  assert.equal(a.match, 'exact'); assert.equal(a.java.major, 17);
  const b = J.selectJava(L, '1.17');
  assert.equal(b.match, 'newer'); assert.equal(b.java.major, 17);
  assert.match(b.warning, /ASM|Forge/);
  const c = J.selectJava(L, '1.21.1');
  assert.equal(c.match, 'exact'); assert.equal(c.java.major, 21);
  const d = J.selectJava(L, '1.16.5');
  assert.equal(d.match, 'exact'); assert.equal(d.java.major, 8);
  const e = J.selectJava(L.slice(0, 1), '1.20.1');
  assert.equal(e.ok, false); assert.equal(e.match, 'missing');
  assert.match(e.error, /Java 17/);
  const f = J.selectJava(L, '1.17', { allowNewer: false });
  assert.equal(f.ok, false, '禁用 allowNewer 时不接受 Java 17 顶替 Java 16');
});

test('Adoptium API 解析真实字段（注入响应，不联网）', async () => {
  const fake = [{
    version_data: { semver: '17.0.21+9' },
    binaries: [{ package: {
      name: 'OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz',
      link: 'https://github.com/adoptium/temurin17-binaries/releases/download/x/OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz',
      checksum: 'a'.repeat(64), size: 193594705
    } }]
  }];
  const a = await J.adoptiumAsset(17, { fetchImpl: async () => resp(fake), platform: 'linux', arch: 'x64' });
  assert.equal(a.major, 17);
  assert.equal(a.version, '17.0.21+9');
  assert.equal(a.checksum, 'a'.repeat(64));
  assert.match(a.link, /temurin17-binaries/);
  assert.match(a.queryUrl, /architecture=x64/);
  assert.match(a.queryUrl, /os=linux/);
});

test('清华镜像目录解析：只取真实存在的文件名，不猜 URL', async () => {
  const html = '<a href="OpenJDK17U-jdk_x64_linux_hotspot_17.0.20_8.tar.gz">a</a>\n' +
    '<a href="OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz">b</a>\n' +
    '<a href="../">up</a>';
  const urls = [];
  const r = await J.tunaCandidates(17, {
    fetchImpl: async u => { urls.push(u); return { ok: true, text: async () => html }; },
    platform: 'linux', arch: 'x64'
  });
  assert.equal(r.urls.length, 2);
  assert.ok(r.urls.every(u => u.startsWith('https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/linux/')));
  assert.ok(r.urls.some(u => u.includes('17.0.21_9')));
  assert.ok(urls[0].endsWith('/17/jdk/x64/linux/'));
});

test('installJava 全流程：下载 → SHA-256 校验 → 解压 → 登记（注入 IO）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-install-'));
  const archiveContent = Buffer.from('FAKE-JDK-ARCHIVE');
  const sha = crypto.createHash('sha256').update(archiveContent).digest('hex');
  const asset = {
    major: 21, name: 'jdk21.tar.gz', link: 'https://example.invalid/jdk21.tar.gz',
    checksum: sha, size: archiveContent.length, version: '21.0.2+13'
  };
  const fetchImpl = async () => resp([{ version_data: { semver: '21.0.2+13' }, binaries: [{ package: {
    name: asset.name, link: asset.link, checksum: sha, size: asset.size } }] }]);
  const stages = [];
  const rec = await J.installJava(21, {
    root: tmp, asset, fetchImpl,
    downloadImpl: async (u, dest) => fs.writeFileSync(dest, archiveContent),
    extractImpl: async (src, dest) => {
      assert.equal(fs.readFileSync(src).toString(), archiveContent.toString());
      const home = path.join(dest, 'jdk-21.0.2');
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(home, 'bin', 'java'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(home, 'release'), 'JAVA_VERSION="21.0.2"\nIMPLEMENTOR="Eclipse Adoptium"\n');
    },
    tunaFetchImpl: null,
    onProgress: p => stages.push(p.stage)
  });
  assert.equal(rec.major, 21);
  assert.equal(rec.sha256, sha);
  assert.equal(rec.source, 'managed');
  assert.ok(fs.existsSync(rec.path));
  assert.ok(stages.includes('verified') && stages.includes('installed'));
  const db = J.loadManaged(tmp);
  assert.equal(db.runtimes.length, 1);
  assert.equal(db.runtimes[0].major, 21);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SHA-256 不匹配时删除归档并抛错，不留下假 JDK', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-badsha-'));
  const asset = { major: 8, name: 'bad.tar.gz', link: 'https://example.invalid/bad.tar.gz', checksum: '0'.repeat(64), version: '8u412' };
  await assert.rejects(
    () => J.installJava(8, {
      root: tmp, asset,
      fetchImpl: async () => ({ ok: true, text: async () => '<a href="../">up</a>' }),
      downloadImpl: async (u, dest) => fs.writeFileSync(dest, Buffer.from('BAD')),
      extractImpl: async () => { throw new Error('不应走到解压'); }
    }),
    /SHA-256 校验失败/
  );
  assert.equal(fs.existsSync(path.join(tmp, 'bad.tar.gz')), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureJava：本地已有精确版本不触发下载；缺失时自动安装', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-ensure-'));
  const local = { list: [{ major: 17, recognized: true, version: '17.0.21', path: '/opt/jdk17/bin/java', source: 'local' }] };
  const ok = await J.ensureJava('1.20.1', { local, root: tmp, autoInstall: false });
  assert.equal(ok.ok, true); assert.equal(ok.source, 'local'); assert.equal(ok.match, 'exact');

  const miss = await J.ensureJava('1.21.1', { local, root: tmp, autoInstall: false });
  assert.equal(miss.ok, false); assert.equal(miss.required.java, 21);

  let installed = 0;
  const auto = await J.ensureJava('1.21.1', {
    local, root: tmp,
    fetchImpl: async () => resp([{ version_data: { semver: '21.0.2' }, binaries: [{ package: {
      name: 'j21.tar.gz', link: 'https://example.invalid/j21.tar.gz', checksum: null, size: 1 } }] }]),
    downloadImpl: async (u, dest) => fs.writeFileSync(dest, Buffer.from('X')),
    extractImpl: async (src, dest) => {
      installed++;
      const home = path.join(dest, 'jdk-21');
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(home, 'bin', 'java'), '');
      fs.writeFileSync(path.join(home, 'release'), 'JAVA_VERSION="21.0.2"\n');
    },
    onProgress: () => {}
  });
  assert.equal(auto.source, 'downloaded');
  assert.equal(auto.installed, true);
  assert.equal(installed, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
