'use strict';
/**
 * updater.cjs — 0.6.0 模块五：自动更新与分发（electron-updater 兼容的 latest.yml 链路）
 *
 * 桌面：每次启动请求 GitHub Release 的 /releases/latest/download/latest.yml，
 *       解析 electron-builder 格式 → 语义化版本比较 → 提示 → 后台静默下载 → sha512 校验。
 * 安卓：请求 GitHub API /releases/latest 做热更新检查提示（不静默安装 APK，明确边界）。
 *
 * 未引入 electron-updater 二进制依赖：其 latest.yml 协议与下载/校验语义在此自研实现，
 * 好处是纯逻辑可测、可走 gh-proxy 镜像、Android 端可复用同一份版本比较代码。
 */
const crypto = require('crypto');
const fs = require('fs');

const releaseCfg = require('../config/release.json');

function unquote(s) {
  const v = String(s == null ? '' : s).trim();
  return v.replace(/^['"]|['"]$/g, '');
}

/** 解析 electron-builder 的 latest.yml（只实现其固定字段子集，不引第三方 YAML 库） */
function parseLatestYml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { version: null, tag: null, path: null, sha512: null, releaseDate: null, files: [] };
  let inFiles = false;
  let current = null;
  for (const line of lines) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      const start = /^\s*-\s*url:\s*(.+)$/.exec(line);
      if (start) {
        current = { url: unquote(start[1]), sha512: null, size: 0 };
        out.files.push(current);
        continue;
      }
      if (current) {
        const kv = /^\s+(sha512|size|url):\s*(.+)$/.exec(line);
        if (kv) {
          if (kv[1] === 'size') current.size = Number(unquote(kv[2])) || 0;
          else current[kv[1]] = unquote(kv[2]);
          continue;
        }
      }
      if (line.trim() && !/^\s/.test(line)) { inFiles = false; current = null; }
    }
    const top = /^([A-Za-z][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (top && !inFiles) {
      const k = top[1];
      if (Object.prototype.hasOwnProperty.call(out, k) && k !== 'files') out[k] = unquote(top[2]);
      else if (k === 'tag') out.tag = unquote(top[2]);
    }
  }
  if (!out.tag && out.version) out.tag = `mc-next-v${out.version}`;
  return out;
}

/** 真实语义化版本比较：支持 v 前缀、三段数字、预发布标识、build metadata */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(.+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}
function compareSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) throw new Error(`非法版本号: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;      // 正式版 > 预发布
  if (!B.pre.length) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn) return -1;
    if (yn) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function latestYmlUrl(release = releaseCfg, useMirror = false) {
  const official = `${release.repo}/releases/latest/download/latest.yml`;
  return useMirror ? `${release.mirror || ''}${official}` : official;
}
function officialDownloadUrl(release, tag, filename) {
  return `${release.repo}/releases/download/${tag}/${filename}`;
}

/**
 * 真实多源获取 latest.yml：官方直链优先，网络异常 / 非 2xx 自动回退 gh-proxy 镜像。
 * 沙盒与国内网络下官方 release 直链常超时，镜像可返回 206/200；两者都失败才向上报错。
 */
async function fetchLatestYml(release, opts) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const official = latestYmlUrl(release, false);
  const mirror = latestYmlUrl(release, true);
  const hasMirror = !!release.mirror && mirror !== official;
  let candidates = [official];
  if (hasMirror && opts.useMirror === false) candidates = [official];
  else if (hasMirror && opts.useMirror === true) candidates = [mirror, official];
  else if (hasMirror) candidates = [official, mirror];

  let lastError = 'latest.yml 请求失败';
  const attempts = [];
  for (const url of candidates) {
    try {
      const resp = await fetchImpl(url, { headers: { 'User-Agent': 'MC-Next-Updater/0.6.0' } });
      attempts.push({ url, status: resp.status });
      if (!resp.ok) { lastError = `latest.yml 请求失败 HTTP ${resp.status}`; continue; }
      return { ok: true, url, text: await resp.text(), attempts };
    } catch (e) {
      attempts.push({ url, error: e.message });
      lastError = `latest.yml 网络请求失败: ${e.message}`;
    }
  }
  return { ok: false, url: official, error: lastError, attempts };
}

/** 桌面端检查：请求真实 latest.yml，返回可下载的官方 / 镜像绝对 URL */
async function checkForUpdate(opts = {}) {
  const release = opts.release || releaseCfg;
  const currentVersion = opts.currentVersion || require('../package.json').version;
  const fetched = await fetchLatestYml(release, opts);
  const url = fetched.url;
  if (!fetched.ok) return { ok: false, error: fetched.error, url, attempts: fetched.attempts };

  const meta = parseLatestYml(fetched.text);
  if (!meta.version) return { ok: false, error: 'latest.yml 缺少 version 字段', url };
  let compare;
  try { compare = compareSemver(meta.version, currentVersion); }
  catch (e) { return { ok: false, error: e.message, url }; }

  const asset = meta.files.find(f => /\.(AppImage|exe|dmg|zip|tar\.gz)$/i.test(f.url))
    || meta.files[0]
    || (meta.path ? { url: meta.path, sha512: meta.sha512, size: 0 } : null);
  if (!asset) return { ok: false, error: 'latest.yml 未声明可下载文件', url };

  const tag = meta.tag || release.tag;
  const official = officialDownloadUrl(release, tag, asset.url);
  return {
    ok: true,
    url,
    source: url,
    attempts: fetched.attempts,
    updateAvailable: compare > 0,
    compare,
    currentVersion,
    latestVersion: meta.version,
    tag,
    asset: { ...asset, name: asset.url },
    officialUrl: official,
    mirrorUrl: `${release.mirror || ''}${official}`,
    sha512: asset.sha512 || meta.sha512 || null,
    size: asset.size || 0,
    releaseDate: meta.releaseDate || null,
    releasePage: `${release.repo}/releases/tag/${tag}`
  };
}

/** 真实校验 electron-builder 的 base64 sha512 */
function verifySha512(file, expectedBase64) {
  if (!expectedBase64) return { ok: false, error: 'latest.yml 未提供 sha512，跳过校验不视为成功' };
  const actual = crypto.createHash('sha512').update(fs.readFileSync(file)).digest();
  let expected;
  try { expected = Buffer.from(expectedBase64, 'base64'); }
  catch { return { ok: false, error: 'sha512 不是合法 base64' }; }
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return { ok, expected: expectedBase64, actual: actual.toString('base64') };
}

/** 安卓端：GitHub Releases API 检查（热更新提示），不静默下载/安装 APK */
async function checkAndroidUpdate(opts = {}) {
  const release = opts.release || releaseCfg;
  const currentVersion = opts.currentVersion || require('../package.json').version;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const ownerRepo = String(release.repo).replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const api = `https://api.github.com/repos/${ownerRepo}/releases/latest`;
  let resp;
  try { resp = await fetchImpl(api, { headers: { 'User-Agent': 'MC-Next-Updater/0.6.0', Accept: 'application/vnd.github+json' } }); }
  catch (e) { return { ok: false, error: `版本检查失败: ${e.message}`, url: api }; }
  if (!resp.ok) return { ok: false, error: `版本检查 HTTP ${resp.status}`, url: api };
  let data;
  try { data = JSON.parse(await resp.text()); }
  catch { return { ok: false, error: 'GitHub 返回非 JSON', url: api }; }
  const tag = data.tag_name || '';
  const latestVersion = /mc-next-v(.+)$/.exec(tag)?.[1] || tag.replace(/^v/, '');
  let compare;
  try { compare = compareSemver(latestVersion, currentVersion); }
  catch { return { ok: false, error: `无法解析远端版本号 ${tag}`, url: api }; }
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const apk = assets.find(a => /Native.*\.apk$/i.test(a.name)) || assets.find(a => /\.apk$/i.test(a.name)) || null;
  const official = apk ? apk.browser_download_url : null;
  return {
    ok: true,
    updateAvailable: compare > 0,
    compare,
    currentVersion,
    latestVersion,
    tag,
    page: data.html_url || `${release.repo}/releases/tag/${tag}`,
    apkName: apk ? apk.name : null,
    apkUrl: official,
    mirrorApkUrl: official ? `${release.mirror || ''}${official}` : null,
    note: 'Android 端仅做检查提示，不静默安装 APK（系统限制），请从 Release 页面下载后手动安装'
  };
}

module.exports = {
  parseLatestYml, parseSemver, compareSemver, latestYmlUrl, officialDownloadUrl,
  fetchLatestYml, checkForUpdate, verifySha512, checkAndroidUpdate
};
