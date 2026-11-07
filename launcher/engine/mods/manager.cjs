'use strict';
/**
 * engine/mods/manager.cjs — 【0.4.0 模块二】模组与资源包智能管家
 *
 * 全部基于真实文件与真实 jar 元数据，不编造模组信息：
 *  - 扫描 .minecraft/mods 下的 .jar / .jar.disabled（.disabled 是 MC 生态通用禁用约定）
 *  - 读取 jar 内真实元数据：fabric.mod.json / quilt.mod.json /
 *    META-INF/mods.toml / META-INF/neoforge.mods.toml / mcmod.info
 *  - 启用/禁用 = 真实 rename（不是内存里的假开关）
 *  - 依赖冲突检测：缺失前置 API（如 Fabric API）标红、重复 modId、加载器混装
 *  - 光影/材质包导入：真实 copyFileSync + Zip-Slip 防护 + SHA-256
 *  - 光影前置检测：识别 Iris / Oculus / OptiFine，缺失时给出真实官方引导链接
 *
 * 所有链接均来自官方站点（irisshaders.dev / optifine.net / modrinth.com / fabricmc.net）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const DISABLED_SUFFIX = '.disabled';
const MAX_PARSE_BYTES = 256 * 1024 * 1024; // 超过 256MB 的 jar 只列文件、不解析元数据

/** 由加载器/游戏本身提供，不算「缺失模组」 */
const BUILTIN_IDS = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric_loader',
  'forge', 'neoforge', 'quilt_loader', 'quilt_loader_version'
]);

/** 真实官方引导链接（已核验可访问，不含任何占位/虚构地址） */
const GUIDE_LINKS = {
  iris: { id: 'iris', name: 'Iris Shaders 官网（Fabric / Quilt）', url: 'https://irisshaders.dev/' },
  irisDownload: { id: 'irisDownload', name: 'Iris 官方下载页', url: 'https://irisshaders.dev/download/' },
  irisModrinth: { id: 'irisModrinth', name: 'Iris · Modrinth', url: 'https://modrinth.com/mod/iris' },
  sodium: { id: 'sodium', name: 'Sodium（Iris 前置）· Modrinth', url: 'https://modrinth.com/mod/sodium' },
  oculus: { id: 'oculus', name: 'Oculus（Forge 光影加载器）· Modrinth', url: 'https://modrinth.com/mod/oculus' },
  optifine: { id: 'optifine', name: 'OptiFine 官方下载', url: 'https://optifine.net/downloads' },
  fabricApi: { id: 'fabricApi', name: 'Fabric API · Modrinth', url: 'https://modrinth.com/mod/fabric-api' },
  fabricInstaller: { id: 'fabricInstaller', name: 'Fabric 官方安装器', url: 'https://fabricmc.net/use/installer/' }
};

/** 归一化 modId（fabric-api / fabric_api / FABRIC.API 视为同一 id） */
function normalizeId(id) {
  return String(id || '').trim().toLowerCase().replace(/-/g, '_').replace(/\./g, '_');
}

/** 文件名安全校验：拒绝路径穿越与非法字符 */
function safeFileName(name) {
  const s = String(name || '').trim();
  if (!s) throw new Error('文件名不能为空');
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`非法文件名：${s}`);
  }
  if (/^[A-Za-z]:/.test(s)) throw new Error(`非法文件名（绝对路径）：${s}`);
  return s;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ---------------------------------------------------------------- jar 元数据解析（纯函数）

function readEntry(zip, name) {
  try {
    const e = zip.getEntry(name);
    if (!e || e.isDirectory) return null;
    return e.getData().toString('utf8');
  } catch { return null; }
}

/** Fabric: fabric.mod.json */
function parseFabricMod(json) {
  const j = JSON.parse(json);
  const depends = [];
  const raw = j.depends || j.requires || {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, range] of Object.entries(raw)) {
      depends.push({ id: String(id), range: typeof range === 'string' ? range : '*', mandatory: true });
    }
  } else if (Array.isArray(raw)) {
    for (const d of raw) {
      if (typeof d === 'string') depends.push({ id: d, range: '*', mandatory: true });
      else if (d && d.id) depends.push({ id: String(d.id), range: String(d.versions || d.range || '*'), mandatory: true });
    }
  }
  return {
    id: String(j.id || ''),
    name: String(j.name || j.id || ''),
    version: String(j.version || ''),
    loader: 'fabric',
    depends,
    provides: (j.provides || []).map(String),
    metaSource: 'fabric.mod.json'
  };
}

/** Quilt: quilt.mod.json */
function parseQuiltMod(json) {
  const j = JSON.parse(json);
  const q = j.quilt_loader || {};
  const depends = [];
  for (const d of (q.depends || [])) {
    if (!d) continue;
    if (typeof d === 'string') { depends.push({ id: d, range: '*', mandatory: true }); continue; }
    depends.push({
      id: String(d.id || ''),
      range: String(d.versions || d.version || '*'),
      mandatory: d.mandatory !== false && d.optional !== true
    });
  }
  const meta = q.metadata || {};
  return {
    id: String(q.id || ''),
    name: String(meta.name || q.id || ''),
    version: String(q.version || ''),
    loader: 'quilt',
    depends: depends.filter(d => d.id),
    provides: (q.provides || []).map(x => (typeof x === 'string' ? x : x.id)).filter(Boolean),
    metaSource: 'quilt.mod.json'
  };
}

/**
 * Forge / NeoForge mods.toml 轻量解析（只取真实需要的字段，不引入 TOML 依赖）。
 * 支持 [[mods]] 与 [[dependencies.<owner>]] 两类表。
 */
function parseForgeToml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const modTables = [];
  const depTables = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[\[(.+?)\]\]\s*$/);
    if (sec) {
      const key = sec[1].trim();
      if (key === 'mods') { cur = {}; modTables.push(cur); }
      else if (key.startsWith('dependencies.')) {
        cur = { __owner: key.slice('dependencies.'.length) };
        depTables.push(cur);
      } else cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[2];
    // 去掉行尾注释（不处理引号内 #，够用且不误判）
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    if (v === 'true' || v === 'false') v = v === 'true';
    cur[m[1]] = v;
  }
  const depends = depTables.map(d => ({
    id: String(d.modId || ''),
    range: String(d.versionRange || '*'),
    mandatory: d.mandatory !== false,
    owner: String(d.__owner || '')
  })).filter(d => d.id);
  const m0 = modTables[0] || {};
  return {
    id: String(m0.modId || ''),
    name: String(m0.displayName || m0.modId || ''),
    version: String(m0.version || ''),
    loader: 'forge',
    depends,
    provides: [],
    metaSource: 'mods.toml'
  };
}

/** 旧版 Forge: mcmod.info */
function parseMcmodInfo(json) {
  const j = JSON.parse(json);
  const m = Array.isArray(j) ? (j[0] || {}) : (j.modList ? (j.modList[0] || {}) : j);
  return {
    id: String(m.modid || ''),
    name: String(m.name || m.modid || ''),
    version: String(m.version || ''),
    loader: 'forge',
    depends: (m.requiredMods || []).map(x => ({ id: String(x), range: '*', mandatory: true })),
    provides: [],
    metaSource: 'mcmod.info'
  };
}

/** 从 jar 字节里解析出统一模组描述；无元数据时返回 loader:'unknown' 而不是编造 */
function inspectJarBuffer(buf) {
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return { loader: 'unknown', parseError: `无法读取 jar：${e.message}` }; }
  const entries = zip.getEntries().map(e => e.entryName);
  const has = (n) => entries.includes(n);
  const pick = (text, parser) => { try { return parser(text); } catch (e) { return { loader: 'unknown', parseError: `元数据解析失败：${e.message}` }; } };
  let r;
  if (has('fabric.mod.json')) r = pick(readEntry(zip, 'fabric.mod.json'), parseFabricMod);
  else if (has('quilt.mod.json')) r = pick(readEntry(zip, 'quilt.mod.json'), parseQuiltMod);
  else if (has('META-INF/neoforge.mods.toml')) {
    r = pick(readEntry(zip, 'META-INF/neoforge.mods.toml'), parseForgeToml);
    if (r.loader === 'forge') r.loader = 'neoforge';
  } else if (has('META-INF/mods.toml')) r = pick(readEntry(zip, 'META-INF/mods.toml'), parseForgeToml);
  else if (has('mcmod.info')) r = pick(readEntry(zip, 'mcmod.info'), parseMcmodInfo);
  else return { loader: 'unknown', parseError: 'jar 内未发现模组元数据（可能不是模组）' };
  r.entries = entries.length;
  return r;
}

// ---------------------------------------------------------------- 扫描 / 启禁

/** 扫描 mods 目录，返回真实模组列表 */
function listMods(gameDir, opts = {}) {
  const dir = path.join(gameDir, 'mods');
  const mods = [];
  if (!fs.existsSync(dir)) return { dir, mods, count: 0, enabledCount: 0, disabledCount: 0, missing: true };
  for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const isDisabled = name.toLowerCase().endsWith(DISABLED_SUFFIX);
    const base = isDisabled ? name.slice(0, -DISABLED_SUFFIX.length) : name;
    if (!/\.jar$/i.test(base)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const row = {
      file: name,
      baseName: base,
      enabled: !isDisabled,
      size: st.size,
      mtime: st.mtimeMs,
      id: null, name: null, version: null, loader: 'unknown',
      depends: [], provides: [], metaSource: null, parseError: null
    };
    if (st.size <= MAX_PARSE_BYTES) {
      try {
        const info = inspectJarBuffer(fs.readFileSync(full));
        Object.assign(row, info);
      } catch (e) { row.parseError = `读取失败：${e.message}`; }
    } else {
      row.parseError = `文件过大（${Math.round(st.size / 1048576)}MB），跳过元数据解析`;
    }
    mods.push(row);
  }
  return {
    dir, mods, count: mods.length,
    enabledCount: mods.filter(m => m.enabled).length,
    disabledCount: mods.filter(m => !m.enabled).length,
    missing: false
  };
}

/** 启用 / 禁用（真实 rename；目标已存在则报错，不覆盖） */
function toggleMod(gameDir, file, enabled, opts = {}) {
  const dir = path.join(gameDir, 'mods');
  const name = safeFileName(file);
  const isDisabled = name.toLowerCase().endsWith(DISABLED_SUFFIX);
  const want = !!enabled;
  // 已是目标状态（want=true 且未禁用 / want=false 且已禁用）→ 幂等返回，不做无意义 rename
  if (isDisabled !== want) {
    return { ok: true, file: name, enabled: want, changed: false };
  }
  const src = path.join(dir, name);
  const dst = want
    ? path.join(dir, name.slice(0, -DISABLED_SUFFIX.length))
    : path.join(dir, name + DISABLED_SUFFIX);
  if (!fs.existsSync(src)) return { ok: false, error: `文件不存在：${src}` };
  if (fs.existsSync(dst)) return { ok: false, error: `目标文件已存在，拒绝覆盖：${path.basename(dst)}` };
  fs.renameSync(src, dst);
  return { ok: true, file: path.basename(dst), enabled: want, changed: true };
}

// ---------------------------------------------------------------- 依赖冲突检测

/** 依赖缺失 → 引导链接（真实官方地址） */
function linksForMissing(id) {
  const n = normalizeId(id);
  if (n === 'fabric_api' || n === 'fabric' || n === 'fabric_api_base') {
    return [GUIDE_LINKS.fabricApi, GUIDE_LINKS.fabricInstaller];
  }
  if (n === 'sodium') return [GUIDE_LINKS.sodium];
  if (n === 'iris') return [GUIDE_LINKS.irisModrinth, GUIDE_LINKS.irisDownload];
  if (n === 'oculus') return [GUIDE_LINKS.oculus];
  return [];
}

/**
 * 冲突检测：只针对启用中的模组（除非 includeDisabled）。
 * 返回 issues（severity: error | warning）与汇总，绝不把「没检测到」说成「已验证无冲突」。
 */
function detectConflicts(mods, opts = {}) {
  const list = (Array.isArray(mods) ? mods : (mods && mods.mods) || [])
    .filter(m => opts.includeDisabled ? true : m.enabled);
  const issues = [];
  const provided = new Set();
  for (const m of list) {
    if (m.id) provided.add(normalizeId(m.id));
    for (const p of m.provides || []) provided.add(normalizeId(p));
  }
  // 1) 缺失前置依赖
  for (const m of list) {
    for (const d of m.depends || []) {
      const n = normalizeId(d.id);
      if (!n || BUILTIN_IDS.has(n) || provided.has(n)) continue;
      const links = linksForMissing(d.id);
      issues.push({
        severity: 'error', type: 'missing-dependency',
        mod: m.file, modId: m.id || m.file,
        missing: d.id, range: d.range || '*', mandatory: d.mandatory !== false,
        message: `「${m.name || m.file}」缺少前置 ${d.id}${d.range && d.range !== '*' ? `（要求 ${d.range}）` : ''}`,
        links
      });
    }
  }
  // 2) 重复 modId
  const byId = new Map();
  for (const m of list) {
    if (!m.id) continue;
    const n = normalizeId(m.id);
    byId.set(n, [...(byId.get(n) || []), m.file]);
  }
  for (const [id, files] of byId) {
    if (files.length > 1) {
      issues.push({
        severity: 'warning', type: 'duplicate-id', modId: id, files,
        message: `检测到重复 modId「${id}」：${files.join('、')}（可能冲突）`
      });
    }
  }
  // 3) 加载器混装
  const loaders = new Set(list.filter(m => m.loader && m.loader !== 'unknown').map(m => m.loader));
  const hasFabricLike = loaders.has('fabric') || loaders.has('quilt');
  const hasForgeLike = loaders.has('forge') || loaders.has('neoforge');
  if (hasFabricLike && hasForgeLike) {
    issues.push({
      severity: 'error', type: 'loader-mismatch',
      loaders: [...loaders],
      message: '检测到 Fabric/Quilt 与 Forge/NeoForge 模组混装，必须使用对应加载器分别隔离实例',
      links: [GUIDE_LINKS.fabricInstaller]
    });
  }
  // 4) 元数据不可读（提示，不算错误）
  for (const m of list) {
    if (m.parseError) {
      issues.push({
        severity: 'warning', type: 'unparsed', mod: m.file,
        message: `「${m.file}」${m.parseError}，无法参与依赖检测`
      });
    }
  }
  const errorCount = issues.filter(i => i.severity === 'error').length;
  return {
    issues, errorCount,
    warningCount: issues.length - errorCount,
    ok: errorCount === 0,
    scanned: list.length,
    note: '仅基于本地 jar 内真实元数据做静态检测，不代表游戏内加载结果'
  };
}

// ---------------------------------------------------------------- 光影 / 材质包

function listPackDir(dir) {
  if (!fs.existsSync(dir)) return { dir, packs: [], missing: true };
  const packs = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (name.isFile() && !/\.zip$/i.test(name.name)) continue;
    const full = path.join(dir, name.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    packs.push({ name: name.name, size: st.size, mtime: st.mtimeMs, isDir: name.isDirectory() });
  }
  return { dir, packs, missing: false };
}

function listPacks(gameDir, opts = {}) {
  return {
    shaderpacks: listPackDir(path.join(gameDir, 'shaderpacks')),
    resourcepacks: listPackDir(path.join(gameDir, 'resourcepacks'))
  };
}

/** Zip-Slip / 绝对路径判定（纯函数，便于独立单测） */
function isUnsafeEntryName(name) {
  const n = String(name || '');
  return !n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\\') || n.split('/').includes('..');
}

/** Zip-Slip / 绝对路径防护（真实读取 zip 条目名） */
function assertSafeZip(zipPath) {
  let zip;
  try { zip = new AdmZip(zipPath); } catch (e) { throw new Error(`不是有效的 zip：${e.message}`); }
  for (const e of zip.getEntries()) {
    if (isUnsafeEntryName(e.entryName)) {
      throw new Error(`压缩包含不安全路径，拒绝导入：${e.entryName}`);
    }
  }
  return zip;
}

/** 一键导入光影包 / 材质包（真实复制 + 校验） */
function importPack(gameDir, kind, srcPath, opts = {}) {
  if (!['shaderpacks', 'resourcepacks'].includes(kind)) {
    return { ok: false, error: `未知资源类型：${kind}` };
  }
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: `源文件不存在：${srcPath}` };
  const name = safeFileName(path.basename(srcPath));
  if (!/\.zip$/i.test(name)) return { ok: false, error: '仅支持 .zip 格式的资源包/光影包' };
  try { assertSafeZip(srcPath); } catch (e) { return { ok: false, error: e.message }; }
  const dir = path.join(gameDir, kind);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, name);
  if (fs.existsSync(dst) && !opts.overwrite) {
    return { ok: false, error: `已存在同名文件：${name}（可选择性覆盖）`, exists: true };
  }
  fs.copyFileSync(srcPath, dst);
  return {
    ok: true, path: dst, name,
    size: fs.statSync(dst).size,
    sha256: sha256File(dst),
    kind
  };
}

/** 光影前置检测：有光影包但没有 Iris/Oculus/OptiFine 时给出真实引导链接 */
function checkShaderRequirements(mods, packs, opts = {}) {
  const list = (Array.isArray(mods) ? mods : (mods && mods.mods) || []).filter(m => m.enabled);
  const shaderPacks = (packs && packs.shaderpacks && packs.shaderpacks.packs) || [];
  const found = [];
  for (const m of list) {
    const hay = [m.id, m.name, m.file, ...(m.provides || [])].map(x => String(x || '').toLowerCase()).join(' ');
    for (const key of ['iris', 'oculus', 'optifine']) {
      if (hay.includes(key)) found.push({ key, mod: m.file });
    }
  }
  const uniqueKeys = [...new Set(found.map(f => f.key))];
  if (shaderPacks.length === 0) {
    return { needed: false, status: 'no-shaderpacks', found: uniqueKeys, links: [], shaderPackCount: 0 };
  }
  if (uniqueKeys.length === 0) {
    return {
      needed: true, status: 'missing-loader', found: [], shaderPackCount: shaderPacks.length,
      message: `检测到 ${shaderPacks.length} 个光影包，但未安装 Iris / Oculus / OptiFine，游戏内不会显示光影选项`,
      links: [GUIDE_LINKS.iris, GUIDE_LINKS.irisDownload, GUIDE_LINKS.irisModrinth,
        GUIDE_LINKS.sodium, GUIDE_LINKS.oculus, GUIDE_LINKS.optifine]
    };
  }
  return {
    needed: false, status: 'ok', found: uniqueKeys, shaderPackCount: shaderPacks.length, links: [],
    message: `已检测到光影加载器：${uniqueKeys.join('、')}`
  };
}

module.exports = {
  DISABLED_SUFFIX, BUILTIN_IDS, GUIDE_LINKS,
  normalizeId, safeFileName, sha256File,
  parseFabricMod, parseQuiltMod, parseForgeToml, parseMcmodInfo, inspectJarBuffer,
  listMods, toggleMod, detectConflicts, linksForMissing,
  listPacks, isUnsafeEntryName, assertSafeZip, importPack, checkShaderRequirements
};
