/**
 * jvmArgs.js — JVM 参数生成器 + Natives 解压
 * 兼容 1.13+ (arguments.jvm) 与旧版 (minecraftArguments 字符串) 两种格式。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { evaluateRules, defaultEnv, isNativesLib, nativesClassifier } = require('./library');
const { normalizeLibrary } = require('./versionJson');

/** 构建占位符替换表 */
function buildSubstitutions(ctx) {
  return {
    classpath: ctx.classpath,
    natives_directory: ctx.nativesDir,
    game_directory: ctx.gameDir,
    assets_root: ctx.assetsDir,
    assets_index_name: ctx.assetIndexId,
    auth_player_name: ctx.playerName || 'Player',
    auth_uuid: ctx.uuid || '00000000-0000-0000-0000-000000000000',
    auth_access_token: ctx.accessToken || 'offline',
    auth_session: ctx.accessToken || 'offline',
    auth_xuid: ctx.xuid || '0',
    user_type: ctx.userType || 'legacy',
    version_type: ctx.versionType || 'MC-Next',
    version_name: ctx.versionId,
    launcher_name: 'MC-Next',
    launcher_version: '0.1.0',
    clientid: 'MC-Next',
    user_properties: '{}',
    quickPlayPath: ctx.quickPlayPath || '',
    ...(ctx.extra || {})
  };
}

function substitute(str, subs) {
  return String(str).replace(/\$\{(\w+)\}/g, (m, k) => (k in subs ? String(subs[k]) : m));
}

/**
 * 生成 JVM 启动参数
 * @returns {{ jvmArgs: string[], gameArgs: string[], classpath: string, substitutions: object }}
 */
function buildJvmArgs(versionJson, ctx = {}) {
  const env = ctx.env || defaultEnv();
  const subs = buildSubstitutions(ctx);
  const jvmArgs = [];

  // 1. 基础内存与库路径（官方启动器等价物）
  if (ctx.minMemory) jvmArgs.push(`-Xms${ctx.minMemory}`);
  if (ctx.maxMemory) jvmArgs.push(`-Xmx${ctx.maxMemory}`);
  jvmArgs.push(`-Djava.library.path=${ctx.nativesDir}`);
  jvmArgs.push(`-Dorg.lwjgl.librarypath=${ctx.nativesDir}`);

  // 2. version.json 自带的 JVM 参数（含 macOS -XstartOnFirstThread 等规则参数）
  if (versionJson.arguments && Array.isArray(versionJson.arguments.jvm)) {
    for (const arg of versionJson.arguments.jvm) {
      if (typeof arg === 'string') {
        jvmArgs.push(substitute(arg, subs));
      } else if (arg && Array.isArray(arg.rules)) {
        if (evaluateRules(arg.rules, env)) {
          const vals = Array.isArray(arg.value) ? arg.value : [arg.value];
          for (const v of vals) jvmArgs.push(substitute(v, subs));
        }
      }
    }
  }

  // 3. 用户自定义 JVM 参数置前优先级最高
  if (Array.isArray(ctx.extraJvmArgs) && ctx.extraJvmArgs.length) {
    jvmArgs.unshift(...ctx.extraJvmArgs);
  }

  // 4. 游戏参数
  const gameArgs = [];
  if (typeof versionJson.minecraftArguments === 'string') {
    // 旧版格式
    for (const t of versionJson.minecraftArguments.split(/\s+/).filter(Boolean)) {
      gameArgs.push(substitute(t, subs));
    }
  } else if (versionJson.arguments && Array.isArray(versionJson.arguments.game)) {
    for (const arg of versionJson.arguments.game) {
      if (typeof arg === 'string') {
        gameArgs.push(substitute(arg, subs));
      } else if (arg && Array.isArray(arg.rules)) {
        if (evaluateRules(arg.rules, env)) {
          const vals = Array.isArray(arg.value) ? arg.value : [arg.value];
          for (const v of vals) gameArgs.push(substitute(v, subs));
        }
      }
    }
  }
  if (ctx.quickPlayPath) {
    gameArgs.push('--quickPlayPath', ctx.quickPlayPath);
  }

  return { jvmArgs, gameArgs, classpath: ctx.classpath, substitutions: subs };
}

/**
 * 解压 natives jar 到目录（跳过 META-INF）
 * @param versionJson 版本 JSON
 * @param nativesDir 解压目标目录
 * @param env 运行环境 {os, arch}
 * @param opts.libRoot 本地 maven 仓库根目录；缺省时按 nativesDir/../libraries 推断
 * @returns {{ extracted:number, skipped:number }}
 */
function extractNatives(versionJson, nativesDir, env, opts = {}) {
  env = env || defaultEnv();
  fs.mkdirSync(nativesDir, { recursive: true });
  const libRoot = opts.libRoot || path.join(nativesDir, '..', 'libraries');
  let extracted = 0, skipped = 0;
  const libs = (versionJson.libraries || []).map(normalizeLibrary).filter(Boolean);
  for (const lib of libs) {
    if (!isNativesLib(lib, env)) continue;
    const jarPath = path.join(libRoot, lib.path); // 调用方保证存在
    if (!fs.existsSync(jarPath)) { skipped++; continue; }
    let zip;
    try { zip = new AdmZip(jarPath); } catch { skipped++; continue; }
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      if (/^META-INF\//.test(e.entryName)) continue;
      const out = path.join(nativesDir, e.entryName);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, zip.readFile(e));
      extracted++;
    }
  }
  return { extracted, skipped };
}

module.exports = { buildJvmArgs, buildSubstitutions, substitute, extractNatives };
