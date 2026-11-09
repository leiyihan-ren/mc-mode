/**
 * isolation.cjs — 极致版本隔离（HMCL 实例 / PCL2 版本独立文件夹）
 *
 * 设计要点（真实 Minecraft 启动语义，不是假目录）：
 *  - 每个实例拥有独立的 .minecraft/{mods,saves,config,resourcepacks,...}
 *  - libraries / assets / versions 在根目录下共享，避免重复下载数十 GB
 *  - 启动时通过 --gameDir 指向实例的 .minecraft，Forge/Fabric/Quilt/NeoForge
 *    均从 gameDir 读取 mods/config，从而实现真正的模组与存档隔离
 *  - 提供从旧式共享 .minecraft 迁移的 migrateLegacy
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 实例独占目录（随 --gameDir 走） */
const ISOLATED_DIRS = [
  'mods', 'saves', 'config', 'resourcepacks', 'shaderpacks',
  'crash-reports', 'logs', 'screenshots', 'schematics', 'downloads'
];
/** 全局共享目录（不随实例复制） */
const SHARED_DIRS = ['libraries', 'assets', 'versions', 'natives'];

function safeId(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('实例 id 不能为空');
  if (s === '.' || s === '..' || /[\\/\0]/.test(s)) throw new Error('非法实例 id: ' + s);
  return s;
}

function instanceRoot(root, id) { return path.join(root, 'instances', safeId(id)); }
function gameDirOf(root, id) { return path.join(instanceRoot(root, id), '.minecraft'); }

/**
 * 创建（幂等）一个隔离实例，返回布局信息。
 * @returns {{base:string, gameDir:string, metaFile:string, meta:object}}
 */
function ensureInstance(root, id, opts = {}) {
  const base = instanceRoot(root, id);
  const gameDir = gameDirOf(root, id);
  for (const d of ISOLATED_DIRS) fs.mkdirSync(path.join(gameDir, d), { recursive: true });
  for (const d of SHARED_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });

  const metaFile = path.join(base, 'instance.json');
  let meta;
  if (fs.existsSync(metaFile)) {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (opts.gameVersion) meta.gameVersion = opts.gameVersion;
    if (opts.loader) meta.loader = opts.loader;
    if (opts.name) meta.name = opts.name;
    meta.updatedAt = new Date().toISOString();
  } else {
    meta = {
      id: safeId(id),
      name: opts.name || safeId(id),
      gameVersion: opts.gameVersion || null,
      loader: opts.loader || null,
      isolated: true,
      createdAt: new Date().toISOString()
    };
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return { base, gameDir, metaFile, meta };
}

/** 生成传给 JVM 的隔离启动参数 */
function buildInstanceArgs(root, id, extras = {}) {
  const gameDir = ensureInstance(root, id).gameDir;
  const args = [
    '--gameDir', gameDir,
    '--assetsDir', path.join(root, 'assets'),
    '--version', extras.version || safeId(id)
  ];
  if (extras.versionType) args.push('--versionType', extras.versionType);
  if (extras.assetIndex) args.push('--assetIndex', extras.assetIndex);
  return args;
}

function listInstances(root) {
  const dir = path.join(root, 'instances');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'instance.json')))
    .map(e => ({ id: e.name, ...JSON.parse(fs.readFileSync(path.join(dir, e.name, 'instance.json'), 'utf8')) }));
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else total += st.size;
  };
  walk(dir);
  return total;
}

/** 实例统计：真实扫描 mods/saves/config 等 */
function instanceInfo(root, id) {
  const { gameDir, meta } = ensureInstance(root, id);
  const modsDir = path.join(gameDir, 'mods');
  const savesDir = path.join(gameDir, 'saves');
  const mods = fs.readdirSync(modsDir).filter(f => /\.(jar|zip)$/i.test(f) || /\.jar\.disabled$/i.test(f));
  const saves = fs.readdirSync(savesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, hasLevelDat: fs.existsSync(path.join(savesDir, e.name, 'level.dat')) }));
  const logs = fs.readdirSync(path.join(gameDir, 'logs'));
  return {
    id: safeId(id), meta, gameDir,
    mods: mods.length, saves: saves.length, saveNames: saves.map(s => s.name),
    logs: logs.length, bytes: dirSize(gameDir)
  };
}

/**
 * 把旧式共享 .minecraft 的内容迁入实例（真实文件移动/复制）。
 * @param {boolean} opts.copy true=复制（保留原目录），false=移动
 */
function migrateLegacy(root, id, legacyMinecraft, opts = {}) {
  const inst = ensureInstance(root, id);
  const moved = [];
  for (const d of ISOLATED_DIRS) {
    const src = path.join(legacyMinecraft, d);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(inst.gameDir, d);
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(dst, name);
      if (fs.existsSync(to)) continue;
      if (opts.copy) fs.cpSync(from, to, { recursive: true });
      else fs.renameSync(from, to);
      moved.push(path.join(d, name));
    }
  }
  return moved;
}

/** 删除实例（非空需 force） */
function removeInstance(root, id, opts = {}) {
  const base = instanceRoot(root, id);
  if (!fs.existsSync(base)) return false;
  const info = instanceInfo(root, id);
  if (!opts.force && (info.mods > 0 || info.saves > 0)) {
    throw new Error(`实例 ${id} 非空（${info.mods} 模组 / ${info.saves} 存档），需显式 force:true`);
  }
  fs.rmSync(base, { recursive: true, force: true });
  return true;
}

// ==================== 0.9.0 模块一A：激活实例会话（多实例完全隔离 + 一键切换） ====================

const ACTIVE_FILE = 'active-instance.json';

/** 读取当前激活实例 id；无记录 / 文件损坏时返回 null（不伪造） */
function getActiveInstance(root) {
  const f = path.join(root, ACTIVE_FILE);
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return o && o.id ? safeId(o.id) : null;
  } catch { return null; }
}

/**
 * 原子切换到目标实例。返回 { ok, from, to, gameDir, error }。
 * 真实校验：目标实例必须已存在（instance.json），否则拒绝，绝不切到空目录。
 * 写入用「临时文件 + rename」保证原子性，避免切换过程中读到半截 JSON。
 */
function switchInstance(root, id, opts = {}) {
  const target = safeId(id);
  const from = getActiveInstance(root);
  const metaFile = path.join(instanceRoot(root, target), 'instance.json');
  if (!fs.existsSync(metaFile)) {
    return { ok: false, from, to: target, gameDir: null, error: `实例 ${target} 不存在，无法切换` };
  }
  // 切换即确保目标实例的隔离目录齐备（幂等），保证 mods/saves/config 物理存在
  const { gameDir } = ensureInstance(root, target);
  const f = path.join(root, ACTIVE_FILE);
  fs.mkdirSync(root, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ id: target, switchedAt: opts.now ? opts.now() : new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
  return { ok: true, from, to: target, gameDir, error: null };
}

/**
 * 启动用 gameDir 解析（单一数据源，供 ipc.launchGameCore 与远程控制共用）：
 *   显式 gameDir > 显式 instanceId > 当前激活实例 > 默认主目录。
 * 带 instanceId / 激活实例时自动 ensureInstance，确保物理隔离目录真实存在。
 * @returns {{gameDir:string, instanceId:string|null, isolated:boolean}}
 */
function gameDirForLaunch(root, o = {}, defaultGameDir = null) {
  if (o.gameDir) {
    // 先校验原始输入：path.resolve(relative) 恒为绝对路径，resolve 后再判 isAbsolute 是无效检查。
    if (!path.isAbsolute(o.gameDir)) throw new Error('gameDir 必须是绝对路径');
    const p = path.resolve(o.gameDir);
    return { gameDir: p, instanceId: null, isolated: false };
  }
  const id = o.instanceId ? safeId(o.instanceId) : getActiveInstance(root);
  if (id) {
    const { gameDir } = ensureInstance(root, id);
    return { gameDir, instanceId: id, isolated: true };
  }
  return { gameDir: defaultGameDir || path.join(root, 'game'), instanceId: null, isolated: false };
}

/**
 * 物理隔离校验：两个不同实例的 gameDir 必须互不包含、且 mods/config/saves 路径两两不同。
 * 供 TDD 与切换前的可读性自检；不修改任何文件。
 */
function verifyIsolation(root, idA, idB) {
  const a = gameDirOf(root, safeId(idA));
  const b = gameDirOf(root, safeId(idB));
  const pathOf = (gd, d) => path.join(gd, d);
  const dirs = ['mods', 'config', 'saves'];
  const overlaps = dirs.filter(d => pathOf(a, d) === pathOf(b, d) ||
    pathOf(a, d).startsWith(b + path.sep) || pathOf(b, d).startsWith(a + path.sep));
  return {
    isolated: a !== b && overlaps.length === 0,
    gameDirA: a, gameDirB: b, overlaps,
    pathA: Object.fromEntries(dirs.map(d => [d, pathOf(a, d)])),
    pathB: Object.fromEntries(dirs.map(d => [d, pathOf(b, d)]))
  };
}

module.exports = {
  ISOLATED_DIRS, SHARED_DIRS, safeId, instanceRoot, gameDirOf,
  ensureInstance, buildInstanceArgs, listInstances, instanceInfo, migrateLegacy, removeInstance,
  // 0.9.0 模块一A
  ACTIVE_FILE, getActiveInstance, switchInstance, gameDirForLaunch, verifyIsolation
};
