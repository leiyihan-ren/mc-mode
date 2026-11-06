/**
 * serverDeploy.js — 服务端自动化部署（全类型覆盖）
 * 支持：原版服务端 / Forge Installer / NeoForge Installer / Fabric / Quilt
 * 流程：识别 jar 类型 -> 静默安装(installer) -> 生成 eula=true -> 生成内存优化启动脚本
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const JAR_KINDS = {
  VANILLA: 'vanilla-server',
  FORGE: 'forge-installer',
  NEOFORGE: 'neoforge-installer',
  FABRIC: 'fabric-server',
  QUILT: 'quilt-server',
  UNKNOWN: 'unknown'
};

function readEntry(jarPath, name) {
  let zip;
  try { zip = new AdmZip(jarPath); } catch { return null; }
  const e = zip.getEntry(name);
  return e ? zip.readFile(e).toString('utf8') : null;
}

function listEntries(jarPath) {
  try { return new AdmZip(jarPath).getEntries().map(e => e.entryName); } catch { return []; }
}

/**
 * 识别 jar 类型（多加载器通用识别逻辑）
 */
function detectJarKind(jarPath) {
  const entries = listEntries(jarPath);
  if (entries.length === 0) return JAR_KINDS.UNKNOWN;

  // 1. Installer 型：install_profile.json 存在
  if (entries.includes('install_profile.json')) {
    const profile = readEntry(jarPath, 'install_profile.json');
    try {
      const p = JSON.parse(profile);
      const libs = JSON.stringify(p.libraries || p.versionInfo?.libraries || []);
      if (/net\.neoforged/.test(libs)) return JAR_KINDS.NEOFORGE;
      return JAR_KINDS.FORGE;
    } catch { /* fallthrough */ }
    return JAR_KINDS.FORGE;
  }

  // 2. Fabric / Quilt 服务端（loader jar 即服务端引导）
  const manifest = readEntry(jarPath, 'META-INF/MANIFEST.MF') || '';
  if (/fabric/i.test(manifest) || entries.some(n => n === 'fabric.mod.json' || n === 'quilt.mod.json')) {
    if (/quilt/i.test(manifest)) return JAR_KINDS.QUILT;
    return JAR_KINDS.FABRIC;
  }
  if (entries.some(n => n === 'quilt_installer.json' || n === 'quilt.mod.json')) return JAR_KINDS.QUILT;

  // 3. 原版服务端：有游戏元数据 version.json 且无加载器痕迹
  const vj = readEntry(jarPath, 'version.json');
  if (vj) {
    try {
      const j = JSON.parse(vj);
      if (j.id || j.protocol_version || j.world_version) return JAR_KINDS.VANILLA;
    } catch { /* ignore */ }
  }
  // 兜底：含 net/minecraft/server 视为原版服务端
  if (entries.some(n => n.startsWith('net/minecraft/server/'))) return JAR_KINDS.VANILLA;
  return JAR_KINDS.UNKNOWN;
}

/** 生成启动脚本（内存优化） */
function generateStartScripts(workDir, opts = {}) {
  const { coreJar = 'server.jar', memory = '4G', javaPath = 'java', extraArgs = '' } = opts;
  const sh = `#!/bin/bash
# MC-Next 自动生成的服务端启动脚本
cd "$(dirname "$0")"
${javaPath} -Xms${memory === '4G' ? '1G' : memory} -Xmx${memory} ${extraArgs}-jar ${coreJar} nogui
`;
  const bat = `@echo off
REM MC-Next 自动生成的服务端启动脚本
cd /d %~dp0
${javaPath} -Xms${memory === '4G' ? '1G' : memory} -Xmx${memory} ${extraArgs}-jar ${coreJar} nogui
pause
`;
  const shPath = path.join(workDir, 'start.sh');
  const batPath = path.join(workDir, 'start.bat');
  fs.writeFileSync(shPath, sh);
  fs.chmodSync(shPath, 0o755);
  fs.writeFileSync(batPath, bat);
  return { sh: shPath, bat: batPath };
}

/** 写 eula=true（部署必要步骤） */
function writeEula(workDir) {
  const p = path.join(workDir, 'eula.txt');
  fs.writeFileSync(p, '# 由 MC-Next 启动器自动生成\neula=true\n');
  return p;
}

/**
 * 部署原版服务端
 */
function deployVanillaServer(jarPath, workDir, opts = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const core = path.join(workDir, 'server.jar');
  fs.copyFileSync(jarPath, core);
  writeEula(workDir);
  const scripts = generateStartScripts(workDir, { ...opts, coreJar: 'server.jar' });
  return { kind: JAR_KINDS.VANILLA, coreJar: core, eula: path.join(workDir, 'eula.txt'), scripts };
}

/**
 * 部署 Installer 型服务端（Forge/NeoForge）
 * 静默执行: java -jar <installer> --installServer <workDir>
 * 安装前先预下载 libraries（多源镜像降级），最大化 installer 本地命中率
 * @returns {Promise<{kind, workDir, scripts, log, prefetch, installerExit, coreJar}>}
 */
async function deployInstallerServer(jarPath, workDir, opts = {}) {
  const kind = detectJarKind(jarPath);
  fs.mkdirSync(workDir, { recursive: true });
  const javaPath = opts.javaPath || 'java';

  // 1. 预下载 libraries（默认开启；installer 检测到 checksum 有效即跳过下载）
  let prefetch = null;
  if (opts.prefetch !== false) {
    try {
      const { prefetchInstallerLibraries } = require('./installerPrefetch');
      prefetch = await prefetchInstallerLibraries(jarPath, path.join(workDir, 'libraries'));
    } catch (e) {
      prefetch = { total: 0, ok: 0, fail: 0, failures: [], error: String(e && e.message || e) };
    }
  }

  // 2. 静默安装（installer 自身完成 libraries 就位与 run 脚本生成）
  const installerLog = [];
  let installerExit = null;
  // 直接 spawn 而不是走 GameLauncher.launch（参数不同）
  const { spawn } = require('child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', jarPath, '--installServer', workDir], { cwd: workDir });
    child.stdout.on('data', d => installerLog.push(d.toString()));
    child.stderr.on('data', d => installerLog.push(d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      installerExit = code;
      resolve(); // 不 reject：退出码交调用方判定（网络缺件时调用方可降级处理）
    });
  });

  // 2. 定位安装产物的核心 jar
  let coreJar = null;
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (f.endsWith('.jar') && !/installer/.test(f)) candidates.push(full);
    }
  };
  walk(workDir, 0);
  coreJar = candidates.find(c => /forge.*universal|neoforge.*universal|server.*jar/i.test(path.basename(c)))
    || candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    || null;

  writeEula(workDir);
  // installer 会生成 run.sh/run.bat，我们额外生成统一优化脚本
  const scripts = generateStartScripts(workDir, {
    ...opts,
    coreJar: coreJar ? path.basename(coreJar) : 'server.jar'
  });
  return { kind, coreJar, eula: path.join(workDir, 'eula.txt'), scripts, log: installerLog.join(''), prefetch, installerExit };
}

/** 从 loader jar 文件名解析 loader 版本（fabric-loader-0.20.1.jar -> 0.20.1） */
function loaderVersionOf(jarPath) {
  const m = path.basename(jarPath).match(/fabric-loader-(.+)\.jar$/i);
  return m ? m[1] : null;
}

/** Maven 坐标 -> 仓库相对路径（支持 classifier 与 @ext） */
function mavenPathOf(name) {
  const parts = String(name).split(':');
  if (parts.length < 3) return null;
  const [g, a, v] = parts;
  let classifier = null, ext = 'jar';
  const rest = parts.slice(3).join(':');
  if (rest) {
    if (rest.includes('@')) { const [c, e] = rest.split('@'); classifier = c; ext = e || 'jar'; }
    else classifier = rest;
  }
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${classifier ? '-' + classifier : ''}.${ext}`;
}

/**
 * 获取 Fabric launcherMeta 启动依赖清单（asm/sponge-mixin 等）
 * @returns {Promise<Array<{name, path, sha1}>>}
 */
async function fetchFabricLauncherMeta(mcVersion, loaderVersion) {
  const { fetchJson } = require('./http');
  const j = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}`, { timeoutMs: 20000 });
  const buckets = j.launcherMeta && j.launcherMeta.libraries;
  if (!buckets) return [];
  const out = [];
  for (const lib of [...(buckets.client || []), ...(buckets.common || [])]) {
    const p = mavenPathOf(lib.name);
    if (p) out.push({ name: lib.name, path: p, sha1: lib.sha1 });
  }
  return out;
}

/**
 * 部署 Fabric/Quilt 服务端
 * loader jar 即引导（自带 ServerLauncher main class）
 * Fabric 的 launcherMeta 声明启动期依赖（asm/sponge-mixin 等），必须入 classpath，
 * 否则 FabricServerLauncher 报 "ASM not detected on the classpath"。
 * 返回 launchClasspath 时调用方应使用 -cp <classpath> <MainClass> 方式启动。
 */
async function deployLoaderServer(jarPath, workDir, opts = {}) {
  const kind = detectJarKind(jarPath);
  fs.mkdirSync(workDir, { recursive: true });
  // 原版服务端核心（外部提供或下载）
  let serverJar = opts.serverJarPath || path.join(workDir, 'server.jar');
  if (opts.serverJarPath && path.resolve(opts.serverJarPath) !== path.resolve(serverJar)) {
    fs.copyFileSync(opts.serverJarPath, serverJar);
  }
  // 引导 jar
  const launcherJar = path.join(workDir, kind === JAR_KINDS.FABRIC ? 'fabric-server-launcher.jar' : 'quilt-server-launcher.jar');
  fs.copyFileSync(jarPath, launcherJar);
  // properties（Fabric 需要; Quilt 不需要）
  if (kind === JAR_KINDS.FABRIC) {
    fs.writeFileSync(path.join(workDir, 'fabric-server-launcher.properties'), 'serverJar=server.jar\n');
  }
  // Fabric launcherMeta 启动依赖（多源下载；失败则回退 -jar 方式由调用方决定）
  let launchClasspath = null;
  const loaderVersion = loaderVersionOf(jarPath);
  if (kind === JAR_KINDS.FABRIC && opts.fetchLauncherMeta !== false && opts.mcVersion && loaderVersion) {
    try {
      const libs = await fetchFabricLauncherMeta(opts.mcVersion, loaderVersion);
      if (libs.length) {
        const { downloadFile } = require('./http');
        const { BMCL } = require('./sources');
        const libsDir = path.join(workDir, 'libraries');
        const localLibs = [];
        for (const lib of libs) {
          const dest = path.join(libsDir, lib.path);
          if (!fs.existsSync(dest)) {
            await downloadFile(`${BMCL}/maven/${lib.path.replace(/\+/g, '%2B')}`, dest, { expectedSha1: lib.sha1, timeoutMs: 60000, retries: 2 });
          }
          localLibs.push(dest);
        }
        launchClasspath = [launcherJar, ...localLibs];
      }
    } catch { /* 回退 -jar */ }
  }
  writeEula(workDir);
  const scripts = generateStartScripts(workDir, { ...opts, coreJar: path.basename(launcherJar) });
  return { kind, coreJar: launcherJar, serverJar, eula: path.join(workDir, 'eula.txt'), scripts, launchClasspath };
}

/**
 * 统一部署入口
 */
async function deployServer(jarPath, workDir, opts = {}) {
  const kind = detectJarKind(jarPath);
  switch (kind) {
    case JAR_KINDS.VANILLA: return deployVanillaServer(jarPath, workDir, opts);
    case JAR_KINDS.FORGE:
    case JAR_KINDS.NEOFORGE: return deployInstallerServer(jarPath, workDir, opts);
    case JAR_KINDS.FABRIC:
    case JAR_KINDS.QUILT: return deployLoaderServer(jarPath, workDir, opts);
    default:
      throw new Error(`无法识别的 jar 类型: ${jarPath}（既非原版/Forge/NeoForge/Fabric/Quilt）`);
  }
}

module.exports = { detectJarKind, deployServer, deployVanillaServer, deployInstallerServer, deployLoaderServer, generateStartScripts, writeEula, mavenPathOf, loaderVersionOf, JAR_KINDS };
