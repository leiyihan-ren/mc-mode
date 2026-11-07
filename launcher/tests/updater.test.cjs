'use strict';
/** 【0.6.0 模块五】自动更新：latest.yml 解析 / 语义化版本 / 静默下载校验 / Android 检查 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const U = require('../engine/updater.cjs');

const YML = `version: 0.6.0
tag: mc-next-v0.6.0
files:
  - url: MC-Next-0.6.0.AppImage
    sha512: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=
    size: 113369715
  - url: MC-Next-0.6.0.tar.gz
    sha512: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=
    size: 107393521
path: MC-Next-0.6.0.AppImage
sha512: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=
releaseDate: '2026-11-07T13:41:00.000Z'
`;
const release = {
  repo: 'https://github.com/leiyihan-ren/mc-mode',
  mirror: 'https://gh-proxy.com/',
  tag: 'mc-next-v0.6.0'
};
const resp = (body, ok = true, status = 200) => ({
  ok, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

// ==================== latest.yml ====================
test('parseLatestYml 解析 electron-builder 真实格式（version/tag/files/path/sha512/releaseDate）', () => {
  const m = U.parseLatestYml(YML);
  assert.equal(m.version, '0.6.0');
  assert.equal(m.tag, 'mc-next-v0.6.0');
  assert.equal(m.path, 'MC-Next-0.6.0.AppImage');
  assert.equal(m.files.length, 2);
  assert.equal(m.files[0].url, 'MC-Next-0.6.0.AppImage');
  assert.equal(m.files[0].size, 113369715);
  assert.equal(m.files[1].size, 107393521);
  assert.equal(m.releaseDate, '2026-11-07T13:41:00.000Z');
});

test('parseLatestYml 无 tag 时按版本推导，坏内容不抛异常', () => {
  const m = U.parseLatestYml('version: 0.7.1\npath: X.AppImage\n');
  assert.equal(m.tag, 'mc-next-v0.7.1');
  assert.deepEqual(U.parseLatestYml('').files, []);
});

test('latestYmlUrl 构造官方绝对 URL 与 gh-proxy 镜像 URL', () => {
  assert.equal(U.latestYmlUrl(release),
    'https://github.com/leiyihan-ren/mc-mode/releases/latest/download/latest.yml');
  assert.equal(U.latestYmlUrl(release, true),
    'https://gh-proxy.com/https://github.com/leiyihan-ren/mc-mode/releases/latest/download/latest.yml');
  assert.equal(U.officialDownloadUrl(release, 'mc-next-v0.6.0', 'X.AppImage'),
    'https://github.com/leiyihan-ren/mc-mode/releases/download/mc-next-v0.6.0/X.AppImage');
});

// ==================== 语义化版本 ====================
test('compareSemver 支持 v 前缀 / 三段数字 / 预发布 / build metadata', () => {
  assert.equal(U.compareSemver('0.6.0', '0.5.0'), 1);
  assert.equal(U.compareSemver('v0.5.0', '0.6.0'), -1);
  assert.equal(U.compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(U.compareSemver('1.0.0', '1.0.0-beta.2'), 1);
  assert.equal(U.compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2'), 1);
  assert.equal(U.compareSemver('1.0.0+build.5', '1.0.0+build.9'), 0);
  assert.throws(() => U.compareSemver('not-a-version', '1.0.0'), /非法版本号/);
});

// ==================== 桌面 update check ====================
test('checkForUpdate：远端版本更新 → 返回官方/镜像绝对 URL 与真实 sha512', async () => {
  const seen = [];
  const r = await U.checkForUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return resp(YML); }
  });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.latestVersion, '0.6.0');
  assert.equal(r.compare, 1);
  assert.equal(r.asset.name, 'MC-Next-0.6.0.AppImage');
  assert.equal(r.officialUrl,
    'https://github.com/leiyihan-ren/mc-mode/releases/download/mc-next-v0.6.0/MC-Next-0.6.0.AppImage');
  assert.ok(r.mirrorUrl.startsWith('https://gh-proxy.com/https://github.com/'));
  assert.equal(r.sha512, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=');
  assert.equal(r.size, 113369715);
  assert.match(seen[0].url, /releases\/latest\/download\/latest\.yml$/);
  assert.match(seen[0].init.headers['User-Agent'], /MC-Next-Updater/);
});

test('checkForUpdate：已是最新不提示；HTTP 失败 / 缺 version / 缺文件都明确报错', async () => {
  const latest = await U.checkForUpdate({ release, currentVersion: '0.6.0', fetchImpl: async () => resp(YML) });
  assert.equal(latest.updateAvailable, false);

  const http = await U.checkForUpdate({ release, currentVersion: '0.5.0', fetchImpl: async () => resp({}, false, 404) });
  assert.equal(http.ok, false);
  assert.match(http.error, /HTTP 404/);

  const noVer = await U.checkForUpdate({ release, currentVersion: '0.5.0', fetchImpl: async () => resp('path: X\n') });
  assert.equal(noVer.ok, false);
  assert.match(noVer.error, /缺少 version/);

  const noFile = await U.checkForUpdate({ release, currentVersion: '0.5.0', fetchImpl: async () => resp('version: 0.9.0\n') });
  assert.equal(noFile.ok, false);
  assert.match(noFile.error, /未声明可下载文件/);
});

test('checkForUpdate 网络异常被捕获为结构化错误，不抛到 UI', async () => {
  const r = await U.checkForUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async () => { throw new Error('DNS 失败'); }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /DNS 失败/);
});

// ==================== sha512 校验 ====================
test('verifySha512 对真实文件按 base64 摘要校验（正确 / 篡改 / 缺失断言）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-updater-'));
  const f = path.join(dir, 'payload.bin');
  const bytes = Buffer.from('MC-NEXT-0.6.0-UPDATE');
  fs.writeFileSync(f, bytes);
  const b64 = crypto.createHash('sha512').update(bytes).digest('base64');
  assert.equal(U.verifySha512(f, b64).ok, true);
  assert.equal(U.verifySha512(f, crypto.createHash('sha512').update('OTHER').digest('base64')).ok, false);
  const missing = U.verifySha512(f, null);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /未提供 sha512/);
});

// ==================== Android 检查 ====================
test('checkAndroidUpdate：解析 GitHub Releases latest，返回 APK 直链与镜像', async () => {
  const seen = [];
  const r = await U.checkAndroidUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async (url) => {
      seen.push(url);
      return resp({
        tag_name: 'mc-next-v0.6.0',
        html_url: 'https://github.com/leiyihan-ren/mc-mode/releases/tag/mc-next-v0.6.0',
        assets: [
          { name: 'MC-Next-Capacitor-0.6.0.apk', browser_download_url: 'https://github.com/x/cap.apk' },
          { name: 'MC-Next-Native-0.6.0.apk', browser_download_url: 'https://github.com/x/native.apk' }
        ]
      });
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.latestVersion, '0.6.0');
  assert.equal(r.apkName, 'MC-Next-Native-0.6.0.apk');
  assert.ok(r.mirrorApkUrl.startsWith('https://gh-proxy.com/https://github.com/'));
  assert.match(r.note, /不静默安装/);
  assert.match(seen[0], /api\.github\.com\/repos\/leiyihan-ren\/mc-mode\/releases\/latest/);
});

test('checkAndroidUpdate：版本相同不提示，API 失败明确报错', async () => {
  const same = await U.checkAndroidUpdate({
    release, currentVersion: '0.6.0',
    fetchImpl: async () => resp({ tag_name: 'mc-next-v0.6.0', assets: [] })
  });
  assert.equal(same.updateAvailable, false);
  const bad = await U.checkAndroidUpdate({
    release, currentVersion: '0.5.0', fetchImpl: async () => resp({}, false, 403)
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 403/);
});

// ==================== 多源回退（官方直链 → gh-proxy 镜像） ====================
test('fetchLatestYml：官方直链网络异常时自动回退 gh-proxy 镜像并返回真实内容', async () => {
  const seen = [];
  const r = await U.checkForUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.startsWith('https://gh-proxy.com/')) return resp(YML);
      throw new Error('connect ETIMEDOUT');
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /^https:\/\/github\.com\//);
  assert.match(seen[1], /^https:\/\/gh-proxy\.com\/https:\/\/github\.com\//);
  assert.equal(r.source, seen[1]);
  assert.equal(r.attempts.length, 2);
  assert.match(r.attempts[0].error, /ETIMEDOUT/);
});

test('fetchLatestYml：官方 HTTP 404 后镜像成功；两源皆失败时保留结构化错误', async () => {
  const fallback = await U.checkForUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async (url) => url.startsWith('https://gh-proxy.com/') ? resp(YML) : resp({}, false, 404)
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.latestVersion, '0.6.0');
  assert.match(fallback.source, /gh-proxy\.com/);

  const bothFail = await U.checkForUpdate({
    release, currentVersion: '0.5.0',
    fetchImpl: async () => { throw new Error('DNS 失败'); }
  });
  assert.equal(bothFail.ok, false);
  assert.match(bothFail.error, /DNS 失败/);
  assert.equal(bothFail.attempts.length, 2);

  const noMirror = await U.fetchLatestYml(
    { repo: release.repo, tag: release.tag }, { fetchImpl: async () => { throw new Error('offline'); } }
  );
  assert.equal(noMirror.attempts.length, 1);
});

// ==================== latest.yml 生成 → 发布 → 检查 全链路闭环 ====================
const gen = require('../tools/gen-latest-yml.cjs');

function makeRealYml() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-yml-'));
  const appImage = path.join(dir, 'MC-Next-0.6.0.AppImage');
  const tarGz = path.join(dir, 'MC-Next-0.6.0.tar.gz');
  fs.writeFileSync(appImage, Buffer.from('REAL-APPIMAGE-BYTES-0.6.0'));
  fs.writeFileSync(tarGz, Buffer.from('REAL-TARGZ-BYTES'));
  const rel = {
    repo: release.repo, mirror: release.mirror, tag: 'mc-next-v0.6.0',
    assets: { appImage: 'MC-Next-0.6.0.AppImage', tarGz: 'MC-Next-0.6.0.tar.gz' }
  };
  const text = gen.buildLatestYml({
    version: '0.6.0', release: rel, distDir: dir, releaseDate: '2026-11-07T00:00:00.000Z'
  });
  return { dir, appImage, tarGz, text };
}

test('gen-latest-yml → parseLatestYml 闭环：sha512/size 全部来自真实文件字节', () => {
  const { appImage, text } = makeRealYml();
  const meta = U.parseLatestYml(text);
  assert.equal(meta.version, '0.6.0');
  assert.equal(meta.tag, 'mc-next-v0.6.0');
  assert.equal(meta.path, 'MC-Next-0.6.0.AppImage');
  assert.equal(meta.files.length, 2);
  assert.equal(meta.files[0].size, Buffer.byteLength('REAL-APPIMAGE-BYTES-0.6.0'));
  assert.equal(meta.files[1].size, Buffer.byteLength('REAL-TARGZ-BYTES'));
  assert.equal(meta.releaseDate, '2026-11-07T00:00:00.000Z');
  // 生成端摘要必须能被 verifySha512 真实校验通过，换一份摘要必须失败
  assert.equal(U.verifySha512(appImage, meta.files[0].sha512).ok, true);
  assert.equal(U.verifySha512(appImage, meta.files[1].sha512).ok, false);
  assert.equal(meta.sha512, meta.files[0].sha512);
});

test('checkForUpdate 消费真实生成的 latest.yml：判定升级且给出可校验的 sha512', async () => {
  const { appImage, text } = makeRealYml();
  const r = await U.checkForUpdate({
    release, currentVersion: '0.5.0', fetchImpl: async () => resp(text)
  });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.latestVersion, '0.6.0');
  assert.equal(r.asset.name, 'MC-Next-0.6.0.AppImage');
  assert.equal(U.verifySha512(appImage, r.sha512).ok, true);
  assert.match(r.officialUrl, /releases\/download\/mc-next-v0\.6\.0\/MC-Next-0\.6\.0\.AppImage$/);
});
