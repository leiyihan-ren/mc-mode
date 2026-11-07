'use strict';
/**
 * engine/modpackExport.cjs — 【0.5.0 模块二】整合包一键封装与分享 + 导入依赖预检
 *
 * 设计要点（真实、自包含、可回环，绝不伪造下载直链）：
 *  - 导出：从版本隔离实例收集 mods/*.jar（启用）、config/**、options.txt，生成标准
 *    Modrinth .mrpack（modrinth.index.json + overrides/），本地模组直接放进 overrides，
 *    不编造远程 URL；额外写 mcnext-manifest.json 记录真实模组元数据 + sha256。
 *    导出的包能被现有 parseMrpack / installPlan 原样读回安装 —— 形成「导出→导入」闭环。
 *  - 依赖版本信息：instance.json 的 gameVersion / loader 反解析为 mrpack dependencies
 *    （minecraft + fabric-loader/forge/neoforge/quilt-loader）。
 *  - 导入预检：解析 overrides 内 jar 的真实元数据，复用 mods 管家 detectConflicts 检测
 *    缺失前置 API（如 Fabric API）；有 error 级问题时返回明确 blocked 结构，由 UI 拦截，
 *    后端 installWithPreflight 也会硬拦截，绝不崩溃、绝不创建半成品实例。
 *
 * 所有 IO 集中在 fs / AdmZip，纯逻辑（依赖解析、拦截判定）可独立单测。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const isolation = require('./isolation.cjs');
const modsMgr = require('./mods/manager.cjs');
const modpack = require('./modpack.cjs');

/** 实例 loader 字符串 → mrpack dependencies key */
const LOADER_DEP_KEY = {
  fabric: 'fabric-loader',
  forge: 'forge',
  neoforge: 'neoforge',
  quilt: 'quilt-loader'
};

const MAX_SINGLE_FILE = 96 * 1024 * 1024;   // 单个文件 96MB 上限
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;  // 整包 512MB 上限
const MAX_FILE_COUNT = 4000;                 // 文件数上限

/** 不导出的敏感 / 非内容目录（隐私与体积护栏） */
const EXCLUDE_NAMES = new Set([
  'usercache.json', 'usernamecache.json', 'launcher_accounts.json',
  'saves', 'logs', 'crash-reports', 'natives', 'versions', 'libraries',
  'assets', 'downloads', '.fabric', '.mixin.out', 'screenshots'
]);

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function safeName(s, fallback) {
  const v = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return v || fallback;
}

/** 把 'fabric-0.15.11' / 'forge-47.2.0' 反解析为 {type, version}；null 表示无加载器 */
function parseLoaderString(loader) {
  const s = String(loader || '').trim();
  if (!s || s === 'null') return null;
  const i = s.indexOf('-');
  const type = (i > 0 ? s.slice(0, i) : s).toLowerCase();
  const version = i > 0 ? s.slice(i + 1) : '';
  if (!LOADER_DEP_KEY[type]) return { type: 'unknown', version, raw: s };
  return { type, version, raw: s };
}

/** 由实例元数据构建 mrpack 标准 dependencies */
function buildDependencies(meta) {
  const deps = {};
  if (meta.gameVersion) deps.minecraft = String(meta.gameVersion);
  const l = parseLoaderString(meta.loader);
  if (l && LOADER_DEP_KEY[l.type] && l.version) deps[LOADER_DEP_KEY[l.type]] = l.version;
  return deps;
}

/** 递归收集一个目录下的文件（相对路径以 dirName 开头） */
function collectDir(base, dirName, out, seen) {
  const root = path.join(base, dirName);
  if (!fs.existsSync(root)) return;
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (EXCLUDE_NAMES.has(e.name)) continue;
      const abs = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : `${dirName}/${e.name}`;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_SINGLE_FILE) { out.skipped.push({ rel: r, reason: '单文件超限' }); continue; }
      out.files.push({ rel: r, abs, size: st.size });
      seen.bytes += st.size; seen.count++;
    }
  };
  walk(root, '');
}

/**
 * 收集实例内容：mods（仅启用 .jar）、config、**options.txt**，可选 resourcepacks/shaderpacks。
 * @returns {{files:Array, skipped:Array, bytes:number, mods:Array, configCount:number, hasOptions:boolean}}
 */
function collectInstanceFiles(gameDir, opts = {}) {
  const out = { files: [], skipped: [] };
  const seen = { bytes: 0, count: 0 };
  // mods：只收启用的 .jar
  const modsDir = path.join(gameDir, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const e of fs.readdirSync(modsDir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.jar$/i.test(e.name)) continue; // .jar.disabled 视为禁用，不导出
      const abs = path.join(modsDir, e.name);
      const st = fs.statSync(abs);
      if (st.size > MAX_SINGLE_FILE) { out.skipped.push({ rel: `mods/${e.name}`, reason: '单文件超限' }); continue; }
      out.files.push({ rel: `mods/${e.name}`, abs, size: st.size });
      seen.bytes += st.size; seen.count++;
    }
  }
  collectDir(gameDir, 'config', out, seen);
  if (opts.includePacks) {
    collectDir(gameDir, 'resourcepacks', out, seen);
    collectDir(gameDir, 'shaderpacks', out, seen);
  }
  const optionsPath = path.join(gameDir, 'options.txt');
  if (fs.existsSync(optionsPath)) {
    const st = fs.statSync(optionsPath);
    out.files.push({ rel: 'options.txt', abs: optionsPath, size: st.size });
    seen.bytes += st.size; seen.count++;
  }
  if (seen.bytes > MAX_TOTAL_BYTES) throw new Error(`实例内容超过 ${Math.round(MAX_TOTAL_BYTES / 1048576)}MB 上限，拒绝导出`);
  if (seen.count > MAX_FILE_COUNT) throw new Error(`实例文件数超过 ${MAX_FILE_COUNT}，拒绝导出`);

  const mods = out.files.filter(f => /^mods\/.*\.jar$/i.test(f.rel)).map(f => f.rel);
  return {
    files: out.files, skipped: out.skipped, bytes: seen.bytes,
    mods,
    configCount: out.files.filter(f => /^config\//.test(f.rel)).length,
    hasOptions: out.files.some(f => f.rel === 'options.txt')
  };
}

/** 读取每个 mod jar 的真实元数据（复用 mods 管家），写进自描述清单 */
function buildModManifest(files, gameDir) {
  const mods = [];
  for (const f of files) {
    if (!/^mods\/.*\.jar$/i.test(f.rel)) continue;
    let info;
    try { info = modsMgr.inspectJarBuffer(fs.readFileSync(f.abs)); }
    catch (e) { info = { loader: 'unknown', parseError: e.message }; }
    mods.push({
      file: path.basename(f.rel),
      id: info.id || null, name: info.name || null, version: info.version || null,
      loader: info.loader || 'unknown',
      depends: info.depends || [], provides: info.provides || [],
      parseError: info.parseError || null,
      size: f.size, sha256: sha256(fs.readFileSync(f.abs))
    });
  }
  return mods;
}

/**
 * 一键导出整合包（标准 .mrpack，自包含）。
 * @param {string} root 启动器根（LAUNCHER_DIR）
 * @param {string} instanceId 隔离实例 id
 * @param {object} opts { outPath?, name?, versionId?, includePacks? }
 * @returns {{ok:boolean, path?, buffer?, name, format, index, manifest, size, sha256, collected, skipped}}
 */
function exportInstance(root, instanceId, opts = {}) {
  const id = isolation.safeId(instanceId);
  const metaFile = path.join(isolation.instanceRoot(root, id), 'instance.json');
  if (!fs.existsSync(metaFile)) {
    return { ok: false, error: `实例「${id}」不存在（未找到 instance.json）` };
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); }
  catch (e) { return { ok: false, error: `实例元数据损坏：${e.message}` }; }
  if (!meta.gameVersion) {
    return { ok: false, error: '实例未声明 MC 版本（gameVersion），无法生成标准整合包' };
  }

  const gameDir = isolation.gameDirOf(root, id);
  const collected = collectInstanceFiles(gameDir, opts);
  const deps = buildDependencies(meta);
  const loader = parseLoaderString(meta.loader);
  const name = opts.name || meta.name || id;

  // 标准 Modrinth index：files 为空（本地模组随 overrides 打包，绝不伪造远程 URL）
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: opts.versionId || '1.0.0',
    name,
    summary: `由 MC-Next 从隔离实例「${meta.name || id}」导出的自包含整合包`,
    dependencies: deps,
    files: []
  };

  const manifest = {
    generator: 'MC-Next',
    schema: 1,
    exportedAt: new Date().toISOString(),
    sourceInstance: { id, name: meta.name, gameVersion: meta.gameVersion, loader: meta.loader || null },
    loader: loader ? { type: loader.type, version: loader.version } : null,
    dependencies: deps,
    note: '本地模组文件打包在 overrides/mods 内（自包含），无远程下载直链；可用 parseMrpack 原样读回。',
    counts: {
      mods: collected.mods.length,
      configFiles: collected.configCount,
      hasOptionsTxt: collected.hasOptions,
      totalFiles: collected.files.length,
      totalBytes: collected.bytes
    },
    mods: buildModManifest(collected.files, gameDir),
    skipped: collected.skipped
  };

  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
  zip.addFile('mcnext-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const f of collected.files) {
    zip.addFile(`overrides/${f.rel}`, fs.readFileSync(f.abs));
  }

  const fileName = `${safeName(name, 'modpack')}-${safeName(meta.gameVersion, 'mc')}.mrpack`;
  let outPath = opts.outPath || null;
  let buffer = null;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    zip.writeZip(outPath);
  } else {
    buffer = zip.toBuffer();
  }
  const bytes = outPath ? fs.readFileSync(outPath) : buffer;
  return {
    ok: true,
    name, format: 'mrpack', fileName,
    path: outPath, buffer,
    size: bytes.length, sha256: sha256(bytes),
    index, manifest,
    collected: {
      mods: collected.mods.length,
      configFiles: collected.configCount,
      optionsTxt: collected.hasOptions,
      totalFiles: collected.files.length,
      skipped: collected.skipped
    }
  };
}

/** 从已导出的 .mrpack（路径或 Buffer）读回自描述清单，供 UI 展示 */
function readExportManifest(input) {
  const zip = new AdmZip(Buffer.isBuffer(input) ? input : fs.readFileSync(input));
  const e = zip.getEntry('mcnext-manifest.json');
  if (!e) return null;
  try { return JSON.parse(e.getData().toString('utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- 导入依赖预检

/**
 * 字节归一化：拖拽导入的 plan 会经 IPC structured clone 往返，
 * overrides[].data 可能是 Buffer / Uint8Array / {type:'Buffer',data:[...]} / number[]。
 * 统一还原成 Buffer，否则 fs.writeFileSync 会拒绝 Object 类型。
 */
function coerceBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data == null) return null;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === 'object') {
    if (Array.isArray(data.data)) return Buffer.from(data.data);   // JSON 化的 Node Buffer
    if (typeof data.data === 'string') return Buffer.from(data.data, 'utf8');
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return null;
}

/** 把整个 plan 的 overrides 字节归一化为 Buffer（返回浅拷贝，不改原对象） */
function normalizePlan(plan) {
  if (!plan) return plan;
  const p = { ...plan };
  if (Array.isArray(plan.overrides)) {
    p.overrides = plan.overrides.map(e => ({ ...e, data: coerceBytes(e.data) }));
  }
  return p;
}

/** 把 plan.overrides 内 jar 的真实元数据解析成 mods 管家的行结构 */
function modsFromOverrides(plan) {
  const rows = [];
  const overrides = Array.isArray(plan && plan.overrides) ? plan.overrides : [];
  for (const e of overrides) {
    if (!/\.jar$/i.test(String(e.name || ''))) continue;
    const data = coerceBytes(e.data);
    if (!Buffer.isBuffer(data)) continue;
    let info;
    try { info = modsMgr.inspectJarBuffer(data); }
    catch (err) { info = { loader: 'unknown', parseError: err.message }; }
    rows.push({
      file: String(e.name).replace(/^overrides\//, ''),
      enabled: true,
      id: info.id || null, name: info.name || null, version: info.version || null,
      loader: info.loader || 'unknown',
      depends: info.depends || [], provides: info.provides || [],
      parseError: info.parseError || null
    });
  }
  return rows;
}

/**
 * 导入前依赖预检：缺失前置 API / 加载器不匹配 → 明确 blocked，UI 拦截而非崩溃。
 * @param {object} plan parseModpack 的结果
 * @param {object} opts { modRows? 已解析模组行；strictLoader? }
 * @returns {{ok, blocked, issues, errorCount, warningCount, scanned, gameVersion, loaders, summary, links}}
 */
function preflightImport(plan, opts = {}) {
  const p = plan || {};
  const modRows = Array.isArray(opts.modRows) ? opts.modRows : modsFromOverrides(p);
  const conflicts = modsMgr.detectConflicts(modRows, { includeDisabled: true });
  const issues = conflicts.issues.slice();
  const loaders = (p.loaders || []).filter(l => l && l.type && l.type !== 'unknown');
  const loaderTypes = new Set(loaders.map(l => l.type));

  // 加载器依赖一致性：解析到 Fabric / Forge 系模组，但整合包未声明对应加载器
  const modLoaderTypes = new Set(modRows.filter(m => m.loader && m.loader !== 'unknown').map(m => m.loader));
  const needsFabric = [...modLoaderTypes].some(t => t === 'fabric' || t === 'quilt');
  const needsForge = [...modLoaderTypes].some(t => t === 'forge' || t === 'neoforge');
  const hasFabric = [...loaderTypes].some(t => t === 'fabric' || t === 'quilt');
  const hasForge = [...loaderTypes].some(t => t === 'forge' || t === 'neoforge');
  if (modRows.length) {
    if (needsFabric && !hasFabric) {
      issues.push({
        severity: 'error', type: 'loader-missing',
        message: '整合包含有 Fabric/Quilt 模组，但未声明 fabric-loader 依赖，安装后将无法启动',
        links: [modsMgr.GUIDE_LINKS.fabricInstaller]
      });
    }
    if (needsForge && !hasForge) {
      issues.push({
        severity: 'error', type: 'loader-missing',
        message: '整合包含有 Forge/NeoForge 模组，但未声明 forge/neoforge 依赖，安装后将无法启动',
        links: []
      });
    }
  }
  if (!p.gameVersion) {
    issues.push({ severity: 'error', type: 'game-version-missing', message: '整合包未声明 MC 版本（dependencies.minecraft），无法创建实例', links: [] });
  }

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const blocked = errorCount > 0;
  const links = [...new Map(issues.flatMap(i => i.links || []).map(l => [l.url || l.id, l])).values()];
  const firstError = issues.find(i => i.severity === 'error');
  const summary = blocked
    ? `已拦截导入：检测到 ${errorCount} 项阻断问题${firstError ? `（${firstError.message}）` : ''}。请补齐缺失依赖或修改整合包后重试，未创建任何实例目录。`
    : `预检通过：扫描 ${modRows.length} 个内嵌模组，${warningCount} 条提示，无阻断问题。`;

  return {
    ok: !blocked, blocked, issues, errorCount, warningCount,
    scanned: modRows.length,
    gameVersion: p.gameVersion || null,
    loaders,
    links,
    summary
  };
}

/**
 * 带预检的一键安装：blocked 时后端硬拦截（不创建实例、不下载、不崩溃）。
 * @param {object} o installPlan 的所有参数 + { preflight?:boolean, force?:boolean }
 */
async function installWithPreflight(o = {}) {
  // 拖拽导入经 IPC 往返后 overrides 字节可能被 clone 成 Uint8Array / JSON Buffer 对象，
  // 先归一化，保证预检解析与文件释放都拿到真正的 Buffer。
  const plan = normalizePlan(o.plan);
  const pf = preflightImport(plan, o);
  if (o.preflight !== false && pf.blocked && !o.force) {
    return { ok: false, blocked: true, preflight: pf, error: pf.summary };
  }
  const report = await modpack.installPlan({ ...o, plan });
  return { ok: true, blocked: false, preflight: pf, ...report };
}

/** 轻量、可序列化的整合包摘要（用于拖拽导入 UI，剔除大 Buffer） */
function describeModpack(plan, opts = {}) {
  const p = plan || {};
  const pf = preflightImport(p, opts);
  return {
    format: p.format, name: p.name, versionId: p.versionId,
    gameVersion: p.gameVersion || null,
    loaders: p.loaders || [],
    fileCount: (p.files || []).length,
    overrideCount: Array.isArray(p.overrides) ? p.overrides.length : 0,
    overrideJarCount: Array.isArray(p.overrides) ? p.overrides.filter(e => /\.jar$/i.test(String(e.name || ''))).length : 0,
    unresolved: (p.unresolved || []).length,
    preflight: pf
  };
}

module.exports = {
  LOADER_DEP_KEY, MAX_SINGLE_FILE, MAX_TOTAL_BYTES, MAX_FILE_COUNT, EXCLUDE_NAMES,
  parseLoaderString, buildDependencies, collectInstanceFiles, buildModManifest,
  exportInstance, readExportManifest,
  coerceBytes, normalizePlan, modsFromOverrides, preflightImport, installWithPreflight, describeModpack
};
