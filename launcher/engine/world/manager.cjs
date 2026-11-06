'use strict';
/**
 * engine/world/manager.cjs — 模块三：本地世界（存档）智能管家
 *
 *  - 扫描 .minecraft/saves，逐个解析 level.dat（自研 NBT 解析器）读取种子/版本/游戏时间
 *  - 真实累计游玩时长优先取 stats/<uuid>.json 的 minecraft:play_time（单位 tick）；
 *    没有 stats 时明确标注为「世界内游戏时间估算」，绝不把 Time 冒充真实游玩时长
 *  - 模组信息：level.dat 的 FML/Forge/Fabric 标志 + 版本隔离实例的 mods/*.jar 清单
 *  - 一键 zip 备份 / 回滚，自动保留最近 5 份，回滚前自动生成 pre-restore 快照
 *  - 解压前逐条校验 zip entry，防 Zip-Slip 路径穿越
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { levelSummary, toPlain } = require('./nbt.cjs');

const KEEP_BACKUPS = 5;
const TICKS_PER_SECOND = 20;

function defaultIo() {
  return {
    readDir: p => fs.readdirSync(p, { withFileTypes: true }),
    readText: p => fs.readFileSync(p, 'utf8'),
    readBuf: p => fs.readFileSync(p),
    exists: p => fs.existsSync(p),
    isDir: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    stat: p => fs.statSync(p),
    mkdir: p => fs.mkdirSync(p, { recursive: true }),
    remove: p => fs.rmSync(p, { recursive: true, force: true }),
    write: (p, d) => fs.writeFileSync(p, d)
  };
}

function safeName(s) {
  return String(s || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 80) || 'world';
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function dirSize(p, io, depth = 0) {
  if (depth > 12) return 0;
  let total = 0;
  let entries = [];
  try { entries = io.readDir(p); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full, io, depth + 1);
      else total += io.stat(full).size;
    } catch { /* 忽略被占用文件 */ }
  }
  return total;
}

/**
 * 读取真实累计游玩时长：saves/<world>/stats/<uuid>.json
 * 1.17+ : stats["minecraft:custom"]["minecraft:play_time"]  (单位 tick)
 * 1.12- : stats["stat.playOneMinute"]                       (单位 tick)
 * 多人同一存档取最大玩家值（避免同时在线重复累加）。
 */
function readPlayTime(worldDir, io) {
  const statsDir = path.join(worldDir, 'stats');
  if (!io.isDir(statsDir)) return { ticks: null, source: null, files: 0 };
  let maxTicks = null, files = 0;
  let entries = [];
  try { entries = io.readDir(statsDir); } catch { return { ticks: null, source: null, files: 0 }; }
  for (const e of entries) {
    if (!e.name.endsWith('.json') || e.isDirectory()) continue;
    try {
      const j = JSON.parse(io.readText(path.join(statsDir, e.name)));
      const st = j.stats || j || {};
      const custom = st['minecraft:custom'] || {};
      const v = custom['minecraft:play_time'] ?? custom['stat.playOneMinute'] ?? st['stat.playOneMinute'];
      if (typeof v === 'number' && v >= 0) {
        files++;
        maxTicks = maxTicks == null ? v : Math.max(maxTicks, v);
      }
    } catch { /* 损坏的 stats 文件跳过 */ }
  }
  return { ticks: maxTicks, source: maxTicks == null ? null : 'stats', files };
}

/** 版本隔离实例的 mods 目录清单（真实文件，不臆测） */
function listMods(gameDir, io) {
  const modsDir = path.join(gameDir, 'mods');
  if (!io.isDir(modsDir)) return [];
  let entries = [];
  try { entries = io.readDir(modsDir); } catch { return []; }
  return entries
    .filter(e => !e.isDirectory() && /\.(jar|zip)$/i.test(e.name))
    .map(e => {
      let size = 0;
      try { size = io.stat(path.join(modsDir, e.name)).size; } catch { /* noop */ }
      return { name: e.name, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 单个世界 → 完整摘要 */
function inspectWorld(worldDir, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const gameDir = opts.gameDir || path.dirname(path.dirname(worldDir));
  const levelPath = path.join(worldDir, 'level.dat');
  if (!io.exists(levelPath)) return null;
  let summary;
  try { summary = levelSummary(io.readBuf(levelPath)); }
  catch (e) { return { id: safeName(path.basename(worldDir)), name: path.basename(worldDir), dir: worldDir, error: `level.dat 解析失败: ${e.message}`, parseError: true }; }

  const pt = readPlayTime(worldDir, io);
  const mods = listMods(gameDir, io);
  let icon = null;
  const iconPath = path.join(worldDir, 'icon.png');
  if (opts.withIcon !== false && io.exists(iconPath)) {
    try { icon = `data:image/png;base64,${io.readBuf(iconPath).toString('base64')}`; } catch { /* noop */ }
  }
  // level.dat 的 Time 只是「世界内游戏时间」，仅在缺失 stats 时作为可标注的参考值
  const estSeconds = summary.gameTimeTicks / TICKS_PER_SECOND;
  const realSeconds = pt.ticks == null ? null : pt.ticks / TICKS_PER_SECOND;
  return {
    id: safeName(summary.name || path.basename(worldDir)),
    dirName: path.basename(worldDir),
    name: summary.name || path.basename(worldDir),
    dir: worldDir,
    seed: summary.seed,
    version: summary.version,
    versionId: summary.versionId,
    versionSeries: summary.versionSeries,
    gameTimeTicks: summary.gameTimeTicks,
    gameDays: summary.gameDays,
    gameTimeHuman: humanDuration(estSeconds),
    playTimeTicks: pt.ticks,
    playTimeSeconds: realSeconds,
    playTimeHuman: realSeconds == null ? null : humanDuration(realSeconds),
    playTimeSource: pt.source || 'estimated-from-gameTime',
    playTimeNote: pt.source
      ? `来自 stats/*.json（${pt.files} 份玩家统计），单位 tick，20 tick = 1 秒`
      : '未找到 stats/*.json，此处仅显示 level.dat 的世界内游戏时间（含睡觉跳过），并非真实在线时长',
    lastPlayed: summary.lastPlayed,
    lastPlayedIso: summary.lastPlayed ? new Date(summary.lastPlayed).toISOString() : null,
    gameType: summary.gameTypeName,
    difficulty: summary.difficulty,
    hardcore: summary.hardcore,
    allowCommands: summary.allowCommands,
    spawn: summary.spawn,
    modded: (summary.moddedFlags || []).length > 0 || mods.length > 0,
    moddedFlags: summary.moddedFlags,
    levelModList: summary.modList,
    mods,
    modCount: mods.length,
    icon,
    sizeBytes: opts.withSize === false ? null : dirSize(worldDir, io),
    dataKeys: summary.rawDataKeys
  };
}

/** 扫描游戏目录下的全部世界 */
function listWorlds(gameDir, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const saves = path.join(gameDir, 'saves');
  if (!io.isDir(saves)) return { ok: false, worlds: [], error: `未找到存档目录：${saves}` };
  const worlds = [];
  let entries = [];
  try { entries = io.readDir(saves); } catch (e) { return { ok: false, worlds: [], error: e.message }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const w = inspectWorld(path.join(saves, e.name), { ...opts, io, gameDir });
    if (w) worlds.push(w);
  }
  worlds.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  return { ok: true, gameDir, saves, worlds, scanned: entries.length };
}

function backupRoot(root, world) {
  return path.join(root || path.join(os.homedir(), '.mc-next', 'backups'), safeName(world));
}
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 列出某世界的全部备份（按时间倒序） */
function listBackups(root, world, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const dir = backupRoot(root, world);
  if (!io.isDir(dir)) return [];
  let entries = [];
  try { entries = io.readDir(dir); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.name.endsWith('.zip')) continue;
    const p = path.join(dir, e.name);
    let size = 0;
    try { size = io.stat(p).size; } catch { /* noop */ }
    let meta = null;
    const mp = p.replace(/\.zip$/, '.json');
    if (io.exists(mp)) { try { meta = JSON.parse(io.readText(mp)); } catch { /* noop */ } }
    out.push({ file: p, name: e.name, size, createdAt: (meta && meta.createdAt) || null, meta });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** 保留最近 keep 份，返回被删除的文件列表 */
function pruneBackups(root, world, keep = KEEP_BACKUPS, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const all = listBackups(root, world, { io });
  const removed = [];
  for (const b of all.slice(keep)) {
    try { fs.unlinkSync(b.file); removed.push(b.file); } catch { /* noop */ }
    const mp = b.file.replace(/\.zip$/, '.json');
    try { fs.unlinkSync(mp); } catch { /* noop */ }
  }
  return removed;
}

/** 一键备份：把整个世界目录打成 zip，写入 meta，并清理超额的旧备份 */
function backupWorld(gameDir, world, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const dir = path.join(gameDir, 'saves', world);
  if (!io.isDir(dir)) return { ok: false, error: `世界不存在：${dir}` };
  const outDir = backupRoot(opts.root, world);
  io.mkdir(outDir);
  const base = `${stamp()}-${crypto.randomBytes(2).toString('hex')}${opts.tag ? `-${safeName(opts.tag)}` : ''}`;
  const zipPath = path.join(outDir, `${base}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(dir);            // entries 相对世界根，回滚时直接解压回目标目录
  zip.writeZip(zipPath);
  const buf = fs.readFileSync(zipPath);
  const meta = {
    world, createdAt: new Date().toISOString(), tag: opts.tag || null,
    sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    entries: zip.getEntries().length,
    level: (() => {
      const info = inspectWorld(dir, { ...opts, io, gameDir, withIcon: false, withSize: false });
      return info ? { name: info.name, version: info.version, seed: info.seed, gameDays: info.gameDays } : null;
    })(),
    source: 'MC-Next backupWorld'
  };
  fs.writeFileSync(zipPath.replace(/\.zip$/, '.json'), JSON.stringify(meta, null, 2));
  const removed = pruneBackups(opts.root, world, opts.keep ?? KEEP_BACKUPS, { io });
  return { ok: true, file: zipPath, meta, removed, total: listBackups(opts.root, world, { io }).length };
}

/** 校验 zip 内每条路径，防 Zip-Slip */
function assertSafeZip(zip) {
  const bad = [];
  for (const e of zip.getEntries()) {
    const n = e.entryName.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..') || n.includes('\0')) bad.push(n);
  }
  if (bad.length) throw new Error(`备份包含不安全路径（Zip-Slip 防护）：${bad.slice(0, 3).join(', ')}`);
}

/**
 * 回滚：先给当前状态做 pre-restore 快照，再清空世界目录并解压目标备份。
 * 只允许回滚本启动器备份目录内的 zip。
 */
function restoreWorld(gameDir, world, zipPath, opts = {}) {
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const dir = path.join(gameDir, 'saves', world);
  if (!io.isDir(dir)) return { ok: false, error: `世界不存在：${dir}` };
  const allowedRoot = path.resolve(backupRoot(opts.root, world));
  const resolved = path.resolve(zipPath);
  if (!resolved.startsWith(allowedRoot + path.sep)) return { ok: false, error: '拒绝回滚：备份文件不在本启动器的备份目录内' };
  if (!io.exists(resolved)) return { ok: false, error: `备份文件不存在：${resolved}` };
  let zip;
  try { zip = new AdmZip(resolved); assertSafeZip(zip); }
  catch (e) { return { ok: false, error: e.message }; }

  const pre = opts.skipPreBackup ? null : backupWorld(gameDir, world, { ...opts, io, tag: 'pre-restore' });
  io.remove(dir);
  io.mkdir(dir);
  zip.extractAllTo(dir, true);
  return {
    ok: true, restoredFrom: resolved, entries: zip.getEntries().length,
    preRestoreBackup: pre && pre.ok ? pre.file : null,
    world: inspectWorld(dir, { ...opts, io, gameDir, withIcon: false })
  };
}

module.exports = {
  KEEP_BACKUPS, TICKS_PER_SECOND, defaultIo, safeName, humanDuration, dirSize,
  readPlayTime, listMods, inspectWorld, listWorlds,
  backupRoot, listBackups, pruneBackups, backupWorld, restoreWorld, assertSafeZip
};
