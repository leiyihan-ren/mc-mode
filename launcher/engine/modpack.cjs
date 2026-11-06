/**
 * modpack.cjs — 整合包解析与一键安装（真实格式：Modrinth .mrpack / CurseForge manifest / MultiMC mmc-pack）
 *
 * 规格要点：
 *  - .mrpack: zip 内 modrinth.index.json {formatVersion:1, game, versionId, files[], dependencies{}}
 *            files[].hashes.{sha512,sha1}、downloads[]、env.{client,server}、overrides/ 覆盖目录
 *  - CurseForge: manifest.json {minecraft:{version,modLoaders:[{id,primary}]}, files:[{projectID,fileID}], overrides}
 *            fileID 需通过 CurseForge API 换取真实 downloadUrl；无 API Key 时不伪造 URL，列入 unresolved
 *  - MultiMC / Prism: mmc-pack.json {components:[{uid,version}], formatVersion}
 *
 * 安全：解压 overrides 时做 Zip Slip 路径穿越防护。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { ensureInstance, gameDirOf } = require('./isolation.cjs');
const { downloadBatch: defaultDownloadBatch } = require('./downloader.cjs');

const LOADER_UID = {
  'net.fabricmc.fabric-loader': 'fabric',
  'net.neoforged.neoforge': 'neoforge',
  'net.minecraftforge': 'forge',
  'org.quiltmc.quilt-loader': 'quilt'
};
const MR_DEP_KEYS = {
  'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge',
  'quilt-loader': 'quilt'
};

function _loaderFromCurseId(id) {
  const m = String(id || '').match(/^(forge|fabric|neoforge|quilt)[-@](.+)$/i);
  if (m) return { type: m[1].toLowerCase(), version: m[2] };
  return { type: 'unknown', version: String(id || '') };
}

function _readEntry(zip, name) {
  const e = zip.getEntry(name);
  return e ? e.getData() : null;
}

/** 解析 Modrinth .mrpack（Buffer 或文件路径） */
function parseMrpack(input) {
  const zip = new AdmZip(Buffer.isBuffer(input) ? input : fs.readFileSync(input));
  const idxBuf = _readEntry(zip, 'modrinth.index.json');
  if (!idxBuf) throw new Error('不是有效的 .mrpack：缺少 modrinth.index.json');
  const idx = JSON.parse(idxBuf.toString('utf8'));
  if (idx.formatVersion !== 1) throw new Error(`不支持的 mrpack formatVersion: ${idx.formatVersion}`);

  const loaders = [];
  for (const [k, v] of Object.entries(idx.dependencies || {})) {
    if (k === 'minecraft') continue;
    const type = MR_DEP_KEYS[k];
    if (type) loaders.push({ type, version: v });
  }
  const files = (idx.files || []).map(f => ({
    path: f.path,
    sha1: (f.hashes && f.hashes.sha1) || null,
    sha512: (f.hashes && f.hashes.sha512) || null,
    size: f.fileSize || 0,
    urls: (f.downloads || []).slice(),
    env: f.env || { client: 'required', server: 'required' }
  }));
  const overrides = zip.getEntries()
    .filter(e => !e.isDirectory && /^overrides\//.test(e.entryName))
    .map(e => ({ name: e.entryName.slice('overrides/'.length), data: e.getData() }));
  const extraOverrides = zip.getEntries()
    .filter(e => !e.isDirectory && /^(client-overrides|server-overrides)\//.test(e.entryName))
    .map(e => ({ name: e.entryName.replace(/^(client|server)-overrides\//, ''), data: e.getData(), side: e.entryName.startsWith('client') ? 'client' : 'server' }));

  return {
    format: 'mrpack', name: idx.name || 'Modrinth Modpack', versionId: idx.versionId || '1.0.0',
    gameVersion: idx.dependencies && idx.dependencies.minecraft,
    loaders, files, overrides: overrides.concat(extraOverrides), unresolved: [], raw: idx
  };
}

/** 解析 CurseForge manifest.json（对象 / Buffer / 路径） */
function parseCurseManifest(input) {
  let m = input;
  if (Buffer.isBuffer(input)) m = JSON.parse(input.toString('utf8'));
  else if (typeof input === 'string' && fs.existsSync(input)) m = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!m || !m.minecraft || !m.minecraft.version) throw new Error('不是有效的 CurseForge manifest.json');
  const primary = (m.minecraft.modLoaders || []).find(l => l.primary) || (m.minecraft.modLoaders || [])[0];
  const loaders = primary ? [_loaderFromCurseId(primary.id)] : [];
  const files = (m.files || []).map(f => ({
    projectID: f.projectID, fileID: f.fileID, required: !!f.required,
    // CurseForge 需要 API 才能把 fileID 换成真实 URL，绝不伪造
    apiUrl: `https://api.curseforge.com/v1/mods/${f.projectID}/files/${f.fileID}`,
    urls: [], path: null, env: { client: 'required', server: 'required' }
  }));
  return {
    format: 'curse', name: m.name || 'CurseForge Modpack', versionId: m.version || '1.0.0',
    gameVersion: m.minecraft.version, loaders, files,
    overrides: m.overrides ? { dir: m.overrides } : null,
    unresolved: files.map(f => ({ ...f, reason: '需要 CurseForge API Key 解析下载直链' })), raw: m
  };
}

/** 解析 MultiMC / Prism mmc-pack.json */
function parseMmcPack(input) {
  let p = input;
  if (Buffer.isBuffer(input)) p = JSON.parse(input.toString('utf8'));
  else if (typeof input === 'string' && fs.existsSync(input)) p = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!p || !Array.isArray(p.components)) throw new Error('不是有效的 mmc-pack.json');
  let gameVersion = null;
  const loaders = [];
  for (const c of p.components) {
    if (c.uid === 'net.minecraft') gameVersion = c.version;
    else if (LOADER_UID[c.uid]) loaders.push({ type: LOADER_UID[c.uid], version: c.version });
  }
  return {
    format: 'mmc', name: 'MultiMC/Prism Instance', versionId: '1.0.0',
    gameVersion, loaders, files: [], overrides: null, unresolved: [],
    notes: ['MultiMC 实例需连同 minecraft/ 目录一起导入；仅解析组件元数据'], raw: p
  };
}

/** 自动识别整合包格式并解析 */
function parseModpack(input, opts = {}) {
  if (typeof input === 'object' && !Buffer.isBuffer(input)) {
    if (input.minecraft) return parseCurseManifest(input);
    if (input.components) return parseMmcPack(input);
    throw new Error('无法识别的整合包对象');
  }
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buf.slice(0, 2).toString() === 'PK') {
    const zip = new AdmZip(buf);
    if (_readEntry(zip, 'modrinth.index.json')) return parseMrpack(buf);
    const mf = _readEntry(zip, 'manifest.json');
    if (mf) {
      const plan = parseCurseManifest(mf);
      const prefix = (plan.overrides && plan.overrides.dir ? plan.overrides.dir : 'overrides').replace(/\/+$/, '') + '/';
      plan.overrides = zip.getEntries()
        .filter(e => !e.isDirectory && e.entryName.startsWith(prefix))
        .map(e => ({ name: e.entryName.slice(prefix.length), data: e.getData() }));
      return plan;
    }
    throw new Error('zip 中既无 modrinth.index.json 也无 manifest.json');
  }
  const text = buf.toString('utf8');
  try {
    const j = JSON.parse(text);
    return j.minecraft ? parseCurseManifest(j) : parseMmcPack(j);
  } catch (e) { throw new Error('无法识别的整合包格式: ' + e.message); }
}

/** 只保留客户端需要的文件（env.client !== 'unsupported'） */
function filterClientFiles(plan) {
  return plan.files.filter(f => !f.env || f.env.client !== 'unsupported');
}

/** 安全解压 overrides（Zip Slip 防护） */
function extractOverrides(overrides, targetDir, opts = {}) {
  if (!overrides) return [];
  const entries = Array.isArray(overrides) ? overrides : [];
  const root = path.resolve(targetDir);
  const written = [];
  for (const e of entries) {
    if (opts.clientOnly && e.side && e.side !== 'client') continue;
    const rel = String(e.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`Zip Slip 拦截：非法路径 ${e.name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    written.push(rel);
  }
  return written;
}

/**
 * 用 CurseForge API 把 unresolved fileID 解析成真实下载地址（需 API Key）。
 * 不提供 key 时抛出明确错误，绝不编造直链。
 */
async function resolveCurseFiles(plan, apiKey, fetchImpl = (...a) => fetch(...a)) {
  if (plan.format !== 'curse' || !apiKey) throw new Error('解析 CurseForge 文件需要有效的 API Key');
  const resolved = [];
  for (const f of plan.files) {
    const resp = await fetchImpl(f.apiUrl, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`CurseForge API HTTP ${resp.status} (${f.apiUrl})`);
    const j = await resp.json();
    const d = j.data || {};
    if (!d.downloadUrl) throw new Error(`文件 ${f.fileID} 无 downloadUrl（可能被作者禁用第三方下载）`);
    resolved.push({ ...f, path: 'mods/' + (d.fileName || `${f.projectID}-${f.fileID}.jar`), urls: [d.downloadUrl], size: d.fileLength || 0 });
  }
  return resolved;
}

/**
 * 一键安装：创建隔离实例 → 并发下载全部文件 → 解压 overrides → 写实例元数据。
 * @param {object} o {plan, root, instanceId, downloadBatch, apiKey, onEvent}
 */
async function installPlan(o = {}) {
  const { plan, root, instanceId } = o;
  if (!plan || !root || !instanceId) throw new Error('installPlan 需要 plan / root / instanceId');
  const download = o.downloadBatch || defaultDownloadBatch;
  const inst = ensureInstance(root, instanceId, {
    gameVersion: plan.gameVersion,
    loader: plan.loaders[0] ? `${plan.loaders[0].type}-${plan.loaders[0].version}` : null,
    name: plan.name
  });
  const events = o.onEvent || (() => {});

  let files = filterClientFiles(plan);
  if (plan.format === 'curse' && o.apiKey) files = await resolveCurseFiles({ ...plan, files }, o.apiKey, o.fetchImpl);
  const tasks = files.filter(f => f.urls && f.urls.length && f.path).map(f => ({
    id: f.path, url: f.urls[0], urls: f.urls.slice(1),
    dest: path.join(inst.gameDir, f.path), sha1: f.sha1 || undefined, size: f.size
  }));
  if (o.onEvent) o.onEvent({ type: 'plan', tasks: tasks.length, unresolved: files.filter(f => !f.urls.length).length });

  let dl = { results: [] };
  if (tasks.length) dl = await download(tasks, { concurrency: o.concurrency || 8, onEvent: events });
  const overrideFiles = extractOverrides(plan.overrides, inst.gameDir, { clientOnly: true });

  const report = {
    instance: inst.meta, gameDir: inst.gameDir,
    downloaded: dl.results.filter(r => r.ok).length,
    failed: dl.results.filter(r => !r.ok),
    overrides: overrideFiles,
    unresolved: files.filter(f => !f.urls || !f.urls.length).map(f => f.apiUrl || f.path),
    loaders: plan.loaders, gameVersion: plan.gameVersion
  };
  if (o.onEvent) o.onEvent({ type: 'installed', report });
  return report;
}

module.exports = {
  parseMrpack, parseCurseManifest, parseMmcPack, parseModpack,
  filterClientFiles, extractOverrides, resolveCurseFiles, installPlan,
  LOADER_UID, MR_DEP_KEYS
};
