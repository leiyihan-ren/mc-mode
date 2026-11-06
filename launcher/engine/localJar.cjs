/**
 * localJar.cjs — 本地 Jar 智能解析 + 依赖/Natives 合并（手动导入原版与加载器）
 *
 * 真实识别依据（全部来自实际 Jar 内容，不是扩展名猜测）：
 *  - 原版客户端: MANIFEST Main-Class = net.minecraft.client.Main
 *    · 1.16+ 内嵌 version.json {id:"1.20.1", protocol_version, world_version,...}
 *    · 1.15- 无 version.json，回退到文件名与 class 结构
 *  - 原版服务端: Main-Class = net.minecraft.server.MinecraftServer（旧）或 net.minecraft.bundler.Main（1.18+）
 *    · bundler 内含 META-INF/versions/<mc>/server-<mc>.jar 与 META-INF/versions.list
 *  - NeoForge/Forge Installer: install_profile.json + version.json(inheritsFrom/mainClass)
 *  - Fabric Loader: fabric.mod.json (id=fabricloader) / fabric-installer.json
 *  - 模组: fabric.mod.json / META-INF/mods.toml / META-INF/neoforge.mods.toml / mcmod.info
 *
 * 合并策略：Forge/NeoForge universal 用 overlay 覆盖原版 jar；Fabric/模组进 classpath；
 * 依赖库中的 .so/.dll/.dylib/.jnilib 抽到 natives 目录并生成 -Djava.library.path。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { mergeJars, extractUniversalFromInstaller } = require('./merge.js');

const KIND = {
  VANILLA_CLIENT: 'vanilla-client',
  VANILLA_SERVER: 'vanilla-server',
  FORGE_INSTALLER: 'forge-installer',
  NEOFORGE_INSTALLER: 'neoforge-installer',
  FABRIC_LOADER: 'fabric-loader',
  QUILT_LOADER: 'quilt-loader',
  MOD: 'mod',
  LIBRARY: 'library',
  UNKNOWN: 'unknown'
};
const NATIVE_RE = /\.(so|dll|dylib|jnilib)$/i;

function readText(zip, name) {
  const e = zip.getEntry(name);
  if (!e) return null;
  try { return zip.readFile(e).toString('utf8'); } catch { return null; }
}
function readJson(zip, name) {
  const t = readText(zip, name);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}
function parseManifest(text) {
  const out = {};
  let last = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw) { last = null; continue; }
    if (/^\s/.test(raw) && last) { out[last] += raw.trim(); continue; } // 续行
    const i = raw.indexOf(':');
    if (i < 1) continue;
    last = raw.slice(0, i).trim();
    out[last] = raw.slice(i + 1).trim();
  }
  return out;
}
function versionFromFilename(p) {
  const m = /(?:^|[^0-9])(\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/.exec(path.basename(p));
  return m ? m[1] : null;
}

/**
 * 检查本地 Jar，返回结构化元数据。
 * @param {string} jarPath
 * @param {object} opts {withHash:boolean}
 */
function inspectJar(jarPath, opts = {}) {
  if (!fs.existsSync(jarPath)) throw new Error('Jar 不存在: ' + jarPath);
  const stat = fs.statSync(jarPath);
  let zip;
  try { zip = new AdmZip(jarPath); } catch (e) { throw new Error('不是有效的 Jar/Zip: ' + jarPath + ' (' + e.message + ')'); }
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const names = new Set(entries.map(e => e.entryName));
  const manifest = parseManifest(readText(zip, 'META-INF/MANIFEST.MF'));
  const mainClass = manifest['Main-Class'] || null;
  const versionJson = readJson(zip, 'version.json');
  const installProfile = readJson(zip, 'install_profile.json');
  const fabricMod = readJson(zip, 'fabric.mod.json');
  const quiltMod = readJson(zip, 'quilt.mod.json');
  const fabricInstaller = readJson(zip, 'fabric-installer.json');
  const modsToml = names.has('META-INF/mods.toml') || names.has('META-INF/neoforge.mods.toml');
  const mcmodInfo = names.has('mcmod.info');
  const nativeEntries = [...names].filter(n => NATIVE_RE.test(n));
  const bundler = [...names].filter(n => /^META-INF\/versions\/[^/]+\/server-.*\.jar$/.test(n));
  const signatures = [...names].filter(n => /^META-INF\/.*\.(SF|RSA|DSA)$/i.test(n));

  const info = {
    path: jarPath, size: stat.size, entries: entries.length,
    kind: KIND.UNKNOWN, mainClass, gameVersion: null,
    loaderType: null, loaderVersion: null, modIds: [],
    versionJson, hasInstallProfile: !!installProfile, bundlerEntries: bundler,
    nativeEntries, signatures: signatures.length > 0, warnings: []
  };
  if (opts.withHash) {
    info.sha1 = crypto.createHash('sha1').update(fs.readFileSync(jarPath)).digest('hex');
  }

  // 1. Installer（最高优先级：version.json 是启动器定义而非游戏元数据）
  if (installProfile) {
    const profileText = JSON.stringify(installProfile);
    if (/net\.neoforged|neoforge/i.test(profileText) || /neoforge/i.test(String(versionJson && versionJson.id))) {
      info.kind = KIND.NEOFORGE_INSTALLER; info.loaderType = 'neoforge';
    } else if (/quilt/i.test(profileText)) {
      info.kind = KIND.FORGE_INSTALLER; info.loaderType = 'quilt';
    } else {
      info.kind = KIND.FORGE_INSTALLER; info.loaderType = 'forge';
    }
    info.gameVersion = (versionJson && (versionJson.inheritsFrom || versionJson.id)) || installProfile.minecraft || versionFromFilename(jarPath);
    if (versionJson && versionJson.id) info.loaderVersion = String(versionJson.id).replace(/^(neoforge|forge|fabric|quilt)-/, '');
    return info;
  }

  // 2. 加载器 / 模组标记
  if (fabricMod || fabricInstaller) {
    if (fabricMod && (fabricMod.id === 'fabricloader' || /fabric loader/i.test(fabricMod.name || ''))) {
      info.kind = KIND.FABRIC_LOADER; info.loaderType = 'fabric';
      info.loaderVersion = fabricMod.version || null;
    } else {
      info.kind = KIND.MOD; info.loaderType = 'fabric';
      if (fabricMod && fabricMod.id) info.modIds.push(fabricMod.id);
    }
    return info;
  }
  if (quiltMod) { info.kind = KIND.MOD; info.loaderType = 'quilt'; if (quiltMod.id) info.modIds.push(quiltMod.id); return info; }
  if (modsToml || mcmodInfo) { info.kind = KIND.MOD; info.loaderType = modsToml ? 'forge/neoforge' : 'legacy-forge'; return info; }

  // 3. 原版客户端 / 服务端
  if (mainClass === 'net.minecraft.client.Main') {
    info.kind = KIND.VANILLA_CLIENT;
    info.gameVersion = (versionJson && versionJson.id) || versionFromFilename(jarPath);
    return info;
  }
  if (mainClass && (/^net\.minecraft\.server\./.test(mainClass) || mainClass === 'net.minecraft.bundler.Main')) {
    info.kind = KIND.VANILLA_SERVER;
    info.gameVersion = (versionJson && versionJson.id) || (bundler[0] && /versions\/([^/]+)\//.exec(bundler[0])[1]) || versionFromFilename(jarPath);
    return info;
  }
  if (versionJson && versionJson.protocol_version && versionJson.world_version) {
    info.kind = KIND.VANILLA_CLIENT;
    info.gameVersion = versionJson.id || versionFromFilename(jarPath);
    return info;
  }
  if (names.has('net/minecraft/client/Minecraft.class')) {
    info.kind = KIND.VANILLA_CLIENT;
    info.gameVersion = versionFromFilename(jarPath);
    info.warnings.push('旧版客户端（无 Main-Class），版本由文件名推断');
    return info;
  }
  info.kind = KIND.LIBRARY;
  return info;
}

function safeExtractNatives(jarPath, nativesDir) {
  const zip = new AdmZip(jarPath);
  const root = path.resolve(nativesDir);
  fs.mkdirSync(root, { recursive: true });
  const out = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !NATIVE_RE.test(e.entryName)) continue;
    const dest = path.resolve(root, path.basename(e.entryName));
    if (!dest.startsWith(root + path.sep)) throw new Error('非法 natives 路径: ' + e.entryName);
    fs.writeFileSync(dest, zip.readFile(e));
    out.push(dest);
  }
  return out;
}

/**
 * 由本地 Jar 生成可启动的方案。
 * @param {object} o {gameJar, loaderJars?, libraries?, outDir}
 */
function buildLocalLaunchPlan(o = {}) {
  const { gameJar, loaderJars = [], libraries = [], outDir } = o;
  if (!gameJar || !outDir) throw new Error('需要 gameJar 与 outDir');
  const gameInfo = inspectJar(gameJar);
  if (gameInfo.kind !== KIND.VANILLA_CLIENT) {
    throw new Error(`所选游戏 Jar 不是原版客户端（识别为 ${gameInfo.kind}）: ${gameJar}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let currentGameJar = gameJar;
  let merged = false;
  const classpath = [];
  const warnings = [...gameInfo.warnings];
  const nativesDir = path.join(outDir, 'natives');
  const natives = [];

  for (const lj of loaderJars) {
    const info = inspectJar(lj);
    if (info.kind === KIND.FORGE_INSTALLER || info.kind === KIND.NEOFORGE_INSTALLER) {
      try {
        const uni = extractUniversalFromInstaller(lj, outDir);
        const out = path.join(outDir, `merged-${path.basename(gameJar)}`);
        const m = mergeJars(currentGameJar, uni, out);
        currentGameJar = out; merged = true;
        warnings.push(`overlay 合并 ${path.basename(lj)}: 覆盖 ${m.overwritten} 条 / 新增 ${m.added} 条 / 丢弃签名 ${m.skippedSig} 条`);
      } catch (e) {
        warnings.push(`installer 未找到 universal.jar，改为 classpath 引入: ${e.message}`);
        classpath.unshift(lj);
      }
    } else if (info.kind === KIND.MOD || info.kind === KIND.FABRIC_LOADER || info.kind === KIND.QUILT_LOADER) {
      classpath.unshift(lj);
    } else {
      warnings.push(`无法识别的加载器 Jar（${info.kind}），已加入 classpath: ${lj}`);
      classpath.push(lj);
    }
  }

  for (const lib of libraries) {
    const found = safeExtractNatives(lib, nativesDir);
    natives.push(...found);
    classpath.push(lib);
  }

  const fullClasspath = [...classpath, currentGameJar];
  return {
    kind: gameInfo.kind, gameVersion: gameInfo.gameVersion,
    gameJar: currentGameJar, merged, classpath: fullClasspath,
    nativesDir, natives, warnings,
    jvmArgs: [
      ...(natives.length ? ['-Djava.library.path=' + nativesDir] : []),
      '-cp', fullClasspath.join(path.delimiter)
    ]
  };
}

module.exports = {
  KIND, NATIVE_RE, parseManifest, versionFromFilename, inspectJar,
  safeExtractNatives, buildLocalLaunchPlan
};
