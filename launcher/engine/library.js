/**
 * library.js — 依赖树构建器
 * 职责：OS/arch/features 规则过滤（官方语义）、natives 处理、本地仓库解析、classpath 组装。
 *
 * rules 官方语义（经真实 1.21.11 version.json 验证）：
 *  - rules 为 null/空数组 -> 允许
 *  - rules 非空 -> 默认 disallow；逐条评估，最后匹配的规则决定结果
 *  - java-objc-bridge 仅 [{allow,osx}] 却只在 mac 出现，证实默认必为 disallow
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeLibrary } = require('./versionJson');

const OS_NAMES = { win32: 'windows', darwin: 'osx', linux: 'linux' };
const ARCH_MAP = { x64: 'x64', arm64: 'arm64', ia32: 'x86' };

/** 评估 library rules（Mojang 官方语义） */
function evaluateRules(rules, env) {
  if (!Array.isArray(rules) || rules.length === 0) return true; // 无规则默认允许
  let allowed = false; // 有规则时默认禁止（官方语义）
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    let match = true;
    if (rule.os) {
      const r = rule.os;
      if (r.name && r.name !== env.os) match = false;
      if (r.arch && r.arch !== env.arch) match = false;
      if (r.version) {
        try {
          const re = new RegExp('^' + String(r.version).replace(/\^/, ''));
          if (!re.test(String(env.osVersion || ''))) match = false;
        } catch { match = false; }
      }
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        const actual = env.features ? env.features[k] : undefined;
        if (actual === undefined) { match = false; break; } // 环境未提供该特性
        if (actual !== v) { match = false; break; }
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 从当前进程推断默认环境 */
function defaultEnv(overrides = {}) {
  return {
    os: OS_NAMES[process.platform] || 'linux',
    arch: ARCH_MAP[process.arch] || process.arch,
    osVersion: '',
    features: {},
    ...overrides
  };
}

/** 是否为 natives 库（新版 classifier 形式 / 老版 natives 字段） */
function isNativesLib(lib, env) {
  if (lib.natives) {
    const key = Object.keys(lib.natives).find(k => k === env.os || k === env.arch);
    if (key) return true;
  }
  return !!lib.classifier && /natives/.test(lib.classifier);
}

/** natives classifier 后缀（老版 natives 字段风格） */
function nativesClassifier(lib, env) {
  if (!lib.natives) return null;
  const key = Object.keys(lib.natives).find(k => k === env.os || k === env.arch);
  if (!key) return null;
  return String(lib.natives[key]).replace('${arch}', env.arch === 'x86' ? '32' : '64');
}

/**
 * 组装 classpath
 * @returns {{ classpath: string[], missing: Array, natives: Array }}
 * 说明：natives jar 同时进 classpath 与 natives 解压列表（对齐官方启动器行为）
 */
function buildClasspath(versionJson, opts = {}) {
  const env = opts.env || defaultEnv();
  const repoRoot = opts.repoRoot || path.join(os.homedir(), '.mc-next', 'libraries');
  const classpath = [];
  const missing = [];
  const natives = [];

  // extraJars（loader/intermediary）置最前，确保补丁类优先于原版
  if (Array.isArray(opts.extraJars)) classpath.push(...opts.extraJars);

  const libs = (versionJson.libraries || []).map(normalizeLibrary).filter(Boolean);
  for (const lib of libs) {
    if (!evaluateRules(lib.rules, env)) continue;
    const local = path.join(repoRoot, lib.path);
    classpath.push(local);
    if (!fs.existsSync(local)) {
      missing.push({ path: lib.path, url: lib.url, sha1: lib.sha1, local });
    }
    if (isNativesLib(lib, env)) {
      natives.push({ path: local, url: lib.url, sha1: lib.sha1, classifier: lib.classifier || nativesClassifier(lib, env) });
    }
  }

  // 游戏主 jar 置后
  if (opts.gameJarPath) classpath.push(opts.gameJarPath);
  return { classpath, missing, natives };
}

module.exports = { evaluateRules, defaultEnv, isNativesLib, nativesClassifier, buildClasspath, OS_NAMES, ARCH_MAP };
