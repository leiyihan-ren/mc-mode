/**
 * manifest.js — Mojang 版本清单解析（version_manifest_v2.json）
 * 纯数据模块，无 IO，可离线单测。
 */
'use strict';

/**
 * 解析 version_manifest_v2.json
 * @param {object} raw JSON 对象
 * @returns {{latest:{release:string,snapshot:string}, versions: Array<{id,type,url,sha1,releaseTime}>}}
 */
function parseVersionManifest(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.versions)) {
    throw new Error('非法的 version_manifest_v2 结构');
  }
  const versions = raw.versions.map(v => ({
    id: String(v.id),
    type: String(v.type || 'release'), // release | snapshot | old_beta | old_alpha
    url: String(v.url),
    sha1: v.sha1 ? String(v.sha1) : null,
    releaseTime: v.releaseTime ? String(v.releaseTime) : null
  }));
  const latest = {
    release: raw.latest && raw.latest.release ? String(raw.latest.release) : null,
    snapshot: raw.latest && raw.latest.snapshot ? String(raw.latest.snapshot) : null
  };
  return { latest, versions };
}

/** 过滤正式版（type=release），按版本号新→旧排序 */
function filterReleases(manifest) {
  return manifest.versions
    .filter(v => v.type === 'release')
    .sort((a, b) => compareVersions(b.id, a.id));
}

/** 过滤快照 */
function filterSnapshots(manifest) {
  return manifest.versions.filter(v => v.type === 'snapshot');
}

/** 版本号比较：支持 1.x.y / 26.x / 带后缀(1.14.4-pre1) */
function compareVersions(a, b) {
  const pa = splitVer(a), pb = splitVer(b);
  const len = Math.max(pa.num.length, pb.num.length);
  for (let i = 0; i < len; i++) {
    const x = pa.num[i] || 0, y = pb.num[i] || 0;
    if (x !== y) return x - y;
  }
  // 数字相同：无后缀 > pre > rc
  const rank = (p) => (p.suf === '' ? 2 : p.suf.startsWith('rc') ? 1 : 0);
  return rank(pa) - rank(pb);
}

function splitVer(v) {
  const s = String(v);
  const m = s.match(/^(\d+(?:\.\d+)*)(?:[-_](.+))?$/);
  if (!m) return { num: [], suf: s };
  return { num: m[1].split('.').map(Number), suf: m[2] || '' };
}

module.exports = { parseVersionManifest, filterReleases, filterSnapshots, compareVersions };
