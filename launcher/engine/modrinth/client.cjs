'use strict';
/**
 * client.cjs — 0.6.0 模块四：真实 Modrinth 开放 API v2 客户端 + 一键安装
 *
 * 真实链路（无假数据）：
 *   GET /v2/search?facets=[["project_type:mod"],["versions:1.21.1"],["categories:fabric"]]
 *   GET /v2/project/{id}/version?game_versions=["1.21.1"]&loaders=["fabric"]
 *   GET /v2/version/{id}                     （必需依赖的精确版本）
 *   GET files[].url                          （CDN 真实下载，sha512 校验后落地）
 *
 * 依赖补全：version.dependencies 里 dependency_type==="required" 的项，
 * 用 version_id 精确拉取或按 MC 版本/加载器选最匹配版本，递归解析（有环检测），
 * 主文件与依赖文件一起落到 mods / shaderpacks / resourcepacks。
 * 所有网络调用可注入 fetchImpl，下载可注入 downloadImpl，便于沙盒协议级测试。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { downloadFile } = require('../http.js');

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'MC-Next/0.6.0 (Minecraft Launcher; +https://github.com/leiyihan-ren/mc-mode)';
const PROJECT_TYPES = Object.freeze(['mod', 'shader', 'modpack', 'resourcepack']);
const TARGET_DIR = Object.freeze({
  mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks', modpack: 'modpacks'
});

async function readJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Modrinth 返回了非 JSON 内容'); }
}
function request(url, fetchImpl) {
  return fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
}

/** 构造真实 Modrinth facets 查询串（不同数组 = AND，同数组内 = OR） */
function buildSearchUrl(q = {}) {
  const type = PROJECT_TYPES.includes(q.projectType) ? q.projectType : 'mod';
  const url = new URL(`${API}/search`);
  const facets = [[`project_type:${type}`]];
  if (q.mcVersion) facets.push([`versions:${q.mcVersion}`]);
  if (q.loader && type !== 'shader') facets.push([`categories:${q.loader}`]);
  url.searchParams.set('facets', JSON.stringify(facets));
  url.searchParams.set('query', String(q.query || ''));
  url.searchParams.set('limit', String(Math.min(50, Math.max(1, Number(q.limit) || 20))));
  url.searchParams.set('offset', String(Math.max(0, Number(q.offset) || 0)));
  url.searchParams.set('index', q.index || 'relevance');
  return url.toString();
}

function parseSearchResponse(json) {
  const hits = (json && Array.isArray(json.hits)) ? json.hits : [];
  return {
    total: (json && json.total_hits) || 0,
    hits: hits.map(h => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description || '',
      projectType: h.project_type,
      iconUrl: h.icon_url || null,
      downloads: h.downloads || 0,
      follows: h.follows || 0,
      categories: h.categories || [],
      versions: h.versions || [],
      latestVersion: h.latest_version || null,
      author: h.author || null,
      dateModified: h.date_modified || null,
      sourceUrl: `https://modrinth.com/${h.project_type}/${h.slug || h.project_id}`
    }))
  };
}

async function searchProjects(q = {}, opts = {}) {
  const url = buildSearchUrl(q);
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const resp = await request(url, fetchImpl);
  if (!resp.ok) throw new Error(`Modrinth 搜索失败 HTTP ${resp.status}（${url}）`);
  const parsed = parseSearchResponse(await readJson(resp));
  return { ...parsed, url, query: q };
}

function projectVersionsUrl(projectId, q = {}) {
  const u = new URL(`${API}/project/${encodeURIComponent(projectId)}/version`);
  if (q.mcVersion) u.searchParams.set('game_versions', JSON.stringify([q.mcVersion]));
  if (q.loader) u.searchParams.set('loaders', JSON.stringify([q.loader]));
  return u.toString();
}

function parseVersions(json) {
  const list = Array.isArray(json) ? json : [];
  return list.map(v => ({
    id: v.id,
    projectId: v.project_id,
    name: v.name || v.version_number || '',
    versionNumber: v.version_number || '',
    versionType: v.version_type || 'release',
    loaders: v.loaders || [],
    gameVersions: v.game_versions || [],
    dependencies: (Array.isArray(v.dependencies) ? v.dependencies : []).map(d => ({
      projectId: d.project_id || null,
      versionId: d.version_id || null,
      type: d.dependency_type || 'required'
    })),
    files: (Array.isArray(v.files) ? v.files : []).map(f => ({
      url: f.url,
      filename: f.filename,
      primary: !!f.primary,
      size: f.size || 0,
      sha512: f.hashes && f.hashes.sha512 ? String(f.hashes.sha512).toLowerCase() : null,
      sha1: f.hashes && f.hashes.sha1 ? String(f.hashes.sha1).toLowerCase() : null
    })),
    datePublished: v.date_published || null
  }));
}

function primaryFile(version) {
  if (!version || !version.files || !version.files.length) return null;
  return version.files.find(f => f.primary) || version.files[0];
}

/** 选最匹配版本：MC 版本 + 加载器 + release 优先 + 必须有文件 */
function selectVersion(versions, q = {}) {
  const ranked = versions.map(v => {
    let score = 0;
    if (q.mcVersion && v.gameVersions.includes(q.mcVersion)) score += 10;
    if (q.loader && v.loaders.includes(q.loader)) score += 10;
    score += v.versionType === 'release' ? 3 : v.versionType === 'beta' ? 2 : 1;
    if (primaryFile(v)) score += 1;
    return { v, score };
  }).sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].v : null;
}

async function fetchVersions(q = {}, opts = {}) {
  if (!q.projectId) throw new Error('缺少 projectId');
  const url = projectVersionsUrl(q.projectId, q);
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const resp = await request(url, fetchImpl);
  if (!resp.ok) throw new Error(`Modrinth 版本查询失败 HTTP ${resp.status}`);
  const versions = parseVersions(await readJson(resp));
  return { url, versions, selected: selectVersion(versions, q) };
}

/**
 * 递归解析 required 依赖。返回的每一项都是真实版本对象（含 primary file），
 * 解析不到的项明确标记 missing:true，绝不静默丢弃前置。
 */
async function resolveDependencies(version, ctx = {}) {
  const fetchImpl = ctx.fetchImpl || ((...a) => fetch(...a));
  const queue = (version.dependencies || []).filter(d => d.type === 'required').map(d => ({ ...d, depth: 0 }));
  const visited = new Set();
  const out = [];
  const maxDepth = ctx.maxDepth || 4;
  const limit = ctx.limit || 50;

  while (queue.length && out.length < limit) {
    const d = queue.shift();
    if (d.depth > maxDepth) continue;
    const key = d.versionId || d.projectId;
    if (!key || visited.has(key)) continue;   // 环检测
    visited.add(key);

    let depVersion = null;
    try {
      if (d.versionId) {
        const resp = await request(`${API}/version/${encodeURIComponent(d.versionId)}`, fetchImpl);
        if (resp.ok) depVersion = parseVersions([await readJson(resp)])[0];
      } else if (d.projectId) {
        const resp = await request(projectVersionsUrl(d.projectId, ctx), fetchImpl);
        if (resp.ok) depVersion = selectVersion(parseVersions(await readJson(resp)), ctx);
      }
    } catch (e) {
      out.push({ ok: false, missing: true, projectId: d.projectId, versionId: d.versionId, reason: `依赖解析失败: ${e.message}` });
      continue;
    }
    if (!depVersion) {
      out.push({ ok: false, missing: true, projectId: d.projectId, versionId: d.versionId, reason: '未找到匹配 MC 版本/加载器的依赖版本' });
      continue;
    }
    out.push({ ok: true, ...depVersion, requiredBy: version.projectId || version.id });
    for (const sub of (depVersion.dependencies || []).filter(x => x.type === 'required')) {
      queue.push({ ...sub, depth: d.depth + 1 });
    }
  }
  return out;
}

/** 防路径穿越：只取 basename，白名单字符，拒绝 . / .. */
function safeFileName(name) {
  const base = path.basename(String(name || ''));
  const clean = base.replace(/[^\w.\-+]/g, '_');
  return clean && clean !== '.' && clean !== '..' && !clean.startsWith('..') ? clean : 'resource.jar';
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 一键下载并安装（主文件 + 全部 required 依赖），真实写盘 + 真实 sha512 校验。
 * @param {object} o { project, version, projectType, gameDir, q, onProgress, fetchImpl, downloadImpl }
 */
async function installProject(o = {}) {
  const version = o.version;
  if (!version) throw new Error('缺少 version（请先调用 modrinth:versions 选择版本）');
  if (!o.gameDir) throw new Error('缺少 gameDir');
  const type = PROJECT_TYPES.includes(o.projectType) ? o.projectType : 'mod';
  const dir = path.resolve(o.gameDir, TARGET_DIR[type]);
  fs.mkdirSync(dir, { recursive: true });

  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const q = o.q || { mcVersion: o.mcVersion, loader: o.loader };
  const dependencies = await resolveDependencies(version, { ...q, fetchImpl: o.fetchImpl });
  const missing = dependencies.filter(d => d.ok === false);
  const items = [version, ...dependencies.filter(d => d.ok === true)];
  const installed = [];
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    const f = primaryFile(v);
    if (!f || !f.url) { failures.push({ projectId: v.projectId, error: '版本没有可下载文件' }); continue; }
    const name = safeFileName(f.filename);
    const dest = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.${process.pid}.part`);
    onProgress({ phase: 'download', index: i + 1, total: items.length, name, dependency: i > 0 });
    try {
      const dl = o.downloadImpl || downloadFile;
      await dl(f.url, tmp, {
        timeoutMs: o.timeoutMs || 90000,
        onProgress: (received, total) => onProgress({ phase: 'progress', index: i + 1, total: items.length, name, received, total })
      });
      const actual = await sha512File(tmp);
      if (f.sha512 && actual !== f.sha512) {
        fs.unlinkSync(tmp);
        throw new Error(`SHA-512 不符（期望 ${f.sha512.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…）`);
      }
      fs.renameSync(tmp, dest);
      const stat = fs.statSync(dest);
      installed.push({
        name, path: dest, size: stat.size, sha512: actual,
        projectId: v.projectId, versionId: v.id, dependency: i > 0
      });
      onProgress({ phase: 'done', index: i + 1, total: items.length, name, dependency: i > 0 });
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* noop */ }
      failures.push({ projectId: v.projectId, name, error: e.message });
      onProgress({ phase: 'error', index: i + 1, total: items.length, name, error: e.message });
    }
  }

  return {
    // 缺失必需依赖时不算「完全成功」：主文件可能已落地，UI 会按 installed/missing 分别展示
    ok: installed.length > 0 && failures.length === 0 && missing.length === 0,
    dir, projectType: type, gameDir: o.gameDir,
    project: o.project || null,
    installed, failures,
    dependencies: dependencies.map(d => ({
      ok: !!d.ok, projectId: d.projectId || null, versionId: d.versionId || d.id || null,
      name: d.name || null, reason: d.reason || null
    })),
    missing
  };
}

module.exports = {
  API, USER_AGENT, PROJECT_TYPES, TARGET_DIR,
  buildSearchUrl, parseSearchResponse, searchProjects,
  projectVersionsUrl, parseVersions, primaryFile, selectVersion, fetchVersions,
  resolveDependencies, safeFileName, sha512File, installProject
};
