/**
 * versionJson.js — Jar 内部元数据深度解析（多加载器通用）
 *
 * 实测生态结构（2026-10 本地样本验证）：
 *  - 原版 client/server jar: version.json = 游戏内部元数据(protocol_version/pack_version)，无 mainClass
 *  - NeoForge/Forge 新版 installer jar: version.json = 启动器版本定义(mainClass/inheritsFrom/libraries)
 *  - Forge 旧版 installer jar: 启动器定义在 install_profile.json 的 versionInfo 字段
 *  - Fabric/Quilt loader jar: 仅有 fabric-installer.json / quilt_installer.json（是库，不是版本）
 */
'use strict';

const fs = require('fs');
const AdmZip = require('adm-zip');

/** 判断是否为"启动器版本定义"（而非游戏内部元数据） */
function isLauncherVersionJson(obj) {
  return !!obj && (
    typeof obj.mainClass === 'string' ||
    Array.isArray(obj.libraries) ||
    typeof obj.inheritsFrom === 'string' ||
    typeof obj.minecraftArguments === 'string'
  );
}

function safeReadEntry(zip, name) {
  const e = zip.getEntry(name);
  if (!e) return null;
  try { return zip.readFile(e); } catch { return null; }
}

function parseJson(buf, ctx) {
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) {
    throw new Error(`${ctx} JSON 解析失败: ${e.message}`);
  }
}

/**
 * 读取 jar 内的"启动器版本定义" version.json
 * 依次尝试: version.json(校验形状) -> install_profile.json.versionInfo
 * @returns {object|null}
 */
function readLauncherVersionJson(jarPath) {
  let zip;
  try {
    zip = new AdmZip(jarPath);
  } catch (e) {
    throw new Error(`无法打开 jar: ${jarPath} (${e.message})`);
  }
  const vj = parseJson(safeReadEntry(zip, 'version.json'), jarPath);
  if (isLauncherVersionJson(vj)) return vj;
  // 旧式 Forge: install_profile.json { versionInfo: {...} }
  const ip = parseJson(safeReadEntry(zip, 'install_profile.json'), jarPath);
  if (ip && isLauncherVersionJson(ip.versionInfo)) return ip.versionInfo;
  return null;
}

/** 读取 install_profile.json（服务端安装/合并需要） */
function readInstallProfile(jarPath) {
  let zip;
  try { zip = new AdmZip(jarPath); } catch (e) {
    throw new Error(`无法打开 jar: ${jarPath} (${e.message})`);
  }
  return parseJson(safeReadEntry(zip, 'install_profile.json'), jarPath);
}

/** 读取游戏内部元数据 version.json（协议版本等，用于 UI 展示） */
function readGameMetadata(jarPath) {
  let zip;
  try { zip = new AdmZip(jarPath); } catch (e) {
    throw new Error(`无法打开 jar: ${jarPath} (${e.message})`);
  }
  const vj = parseJson(safeReadEntry(zip, 'version.json'), jarPath);
  if (!vj || isLauncherVersionJson(vj)) return null;
  return {
    id: vj.id || null,
    name: vj.name || null,
    worldVersion: vj.world_version ?? null,
    seriesId: vj.series_id ?? null,
    protocolVersion: vj.protocol_version ?? null,
    packVersion: vj.pack_version ?? null,
    javaVersion: vj.java_version ?? null,
    stable: vj.stable ?? null
  };
}

/**
 * 深度提取启动器版本元信息（多加载器通用）
 */
function extractMeta(versionJson) {
  if (!versionJson || typeof versionJson !== 'object') return null;
  const libs = Array.isArray(versionJson.libraries) ? versionJson.libraries : [];
  const libraries = libs.map(normalizeLibrary).filter(Boolean);

  return {
    id: versionJson.id || null,
    mainClass: versionJson.mainClass || null,
    inheritsFrom: versionJson.inheritsFrom || null,
    libraries,
    assetIndex: versionJson.assetIndex ? {
      id: versionJson.assetIndex.id,
      url: versionJson.assetIndex.url || null,
      sha1: versionJson.assetIndex.sha1 || null,
      totalSize: versionJson.assetIndex.totalSize || null
    } : null,
    assetsDir: versionJson.assets || 'legacy',
    javaVersion: versionJson.javaVersion ? {
      component: versionJson.javaVersion.component,
      majorVersion: versionJson.javaVersion.majorVersion
    } : null,
    minecraftArguments: versionJson.minecraftArguments || null,
    argumentsGame: versionJson.arguments && versionJson.arguments.game ? versionJson.arguments.game : null,
    argumentsJvm: versionJson.arguments && versionJson.arguments.jvm ? versionJson.arguments.jvm : null,
    jar: versionJson.jar || null,
    loader: detectLoader(libraries, versionJson.mainClass)
  };
}

/** 归一化 library 条目：提取 Maven 坐标与规则 */
function normalizeLibrary(lib) {
  if (!lib) return null;
  if (typeof lib === 'string') {
    const base = parseMavenCoords(lib);
    return { ...base, path: mavenPathFromCoords(base), url: null, sha1: null, size: null, rules: null, natives: null, clientreq: false };
  }
  const name = lib.name;
  if (!name) return null;
  const base = parseMavenCoords(name);
  const dl = lib.downloads && lib.downloads.artifact ? lib.downloads.artifact : null;
  return {
    ...base,
    path: (dl && dl.path) || mavenPathFromCoords(base),
    url: (dl && dl.url) || null,
    sha1: (dl && dl.sha1) || null,
    size: (dl && dl.size) || null,
    rules: lib.rules || null,
    natives: lib.natives || null,
    clientreq: lib.clientreq === true
  };
}

/** 解析 Maven 坐标 group:artifact:version[:classifier] */
function parseMavenCoords(name) {
  const parts = String(name).split(':');
  if (parts.length < 3) return { group: null, artifact: name, version: null, classifier: null, raw: name };
  return { group: parts[0], artifact: parts[1], version: parts[2], classifier: parts[3] || null, raw: name };
}

/** group:artifact:version -> maven 路径 */
function mavenPathFromCoords(c) {
  if (!c.group || !c.artifact || !c.version) return null;
  const g = c.group.replace(/\./g, '/');
  const cls = c.classifier ? `-${c.classifier}` : '';
  return `${g}/${c.artifact}/${c.version}/${c.artifact}-${c.version}${cls}.jar`;
}

/** 识别加载器类型（用于启动参数与合并策略） */
function detectLoader(libraries, mainClass) {
  const names = libraries.map(l => l.raw || '').join(' ');
  const mc = mainClass || '';
  if (/net\.fabricmc|fabric-loader/i.test(names) || /fabricmc|knot/i.test(mc)) return 'fabric';
  if (/org\.quiltmc|quilt-loader/i.test(names) || /quiltmc/i.test(mc)) return 'quilt';
  if (/net\.neoforged/i.test(names) || /neoforged|bootstraplauncher/i.test(mc)) return 'neoforge';
  if (/net\.minecraftforge/i.test(names) || /minecraftforge|fmlserverlauncher/i.test(mc)) return 'forge';
  return 'vanilla';
}

module.exports = {
  readLauncherVersionJson, readInstallProfile, readGameMetadata,
  extractMeta, parseMavenCoords, mavenPathFromCoords, normalizeLibrary,
  detectLoader, isLauncherVersionJson
};
