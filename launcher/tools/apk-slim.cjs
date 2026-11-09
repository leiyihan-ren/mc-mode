#!/usr/bin/env node
'use strict';
/**
 * tools/apk-slim.cjs — 0.9.0 模块二B：APK 体积瘦身（可复现 / 白名单式 / 零功能冒险）
 *
 * 【真实剖析结论（见 DELIVERY-0.9.0.md），不删功能依赖凑数字】
 *  当前统一 APK 105.05 MiB：
 *   - assets/runtime/lib/modules 46.58 MiB —— JRE 运行时模块镜像，必需
 *   - lib/arm64-v8a/*.so        46.80 MiB —— 53 个 .so 全部已 strip（可剥离符号段 0 字节），
 *     且 libOSMesa / libvulkan_freedreno 是 v0.7.0 渲染降级链（Zink/VirGL）真实依赖，必需
 *   - 唯一确定可删：JDK 编译期/开发期文件 —— ct.sym(5.60MiB)、man/、CDS classlist、
 *     JFR 配置、JMX/SDP 模板、bin/ 下开发工具（保留 java）、字体配置 .src 模板
 *  jlink 裁剪 modules 虽可省更多，但模块漏选会导致 ClassNotFoundException 且沙盒无真机可验证，
 *  本轮明确不做，仅作为未来需真机验证的可选深度优化记录。
 *
 * 规则放在 tools/apk-slim-rules.json（单一数据源）：
 *  - apply 模式：真实删除，打印删除清单与释放字节（构建脚本 [5.5/9] 调用）
 *  - audit 模式：从 stdin 读 APK 内文件名列表，判定「必需文件齐全 + 瘦身项不残留」
 *    （构建脚本 [9/9] 的 Python zip 校验把 names 通过管道交给这里，判定逻辑只有一份）
 */
const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, 'apk-slim-rules.json');
function loadRules(p = RULES_PATH) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** 判定单个 runtime 内相对路径：'drop' | 'keep'（白名单式：不在删除规则里一律保留） */
function classify(rel, rules = loadRules()) {
  const r = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (rules.mustKeepRuntime.includes(r)) return 'keep';
  if (rules.dropExact.includes(r)) return 'drop';
  if (rules.dropPrefix.some(p => r.startsWith(p))) return 'drop';
  if (rules.dropSuffix.some(s => r.endsWith(s))) return 'drop';
  // bin/ 下仅保留白名单（java），其余开发工具删除；bin/ 子目录内容保守保留
  if (r.startsWith('bin/') && r.split('/').length === 2 && !rules.dropBinExcept.includes(r.slice(4))) {
    return 'drop';
  }
  return 'keep';
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (e.isDirectory()) walk(abs, base, out);
    else out.push({ rel, abs, size: fs.statSync(abs).size });
  }
  return out;
}

/** 扫描 runtime 目录，返回删除计划（不落盘） */
function planSlim(runtimeDir, rules = loadRules()) {
  const entries = walk(runtimeDir);
  const drops = [];
  const keeps = [];
  for (const e of entries) (classify(e.rel, rules) === 'drop' ? drops : keeps).push(e);
  const missingMustKeep = rules.mustKeepRuntime.filter(p => !fs.existsSync(path.join(runtimeDir, p)));
  return {
    totalEntries: entries.length,
    drops,
    keeps,
    freedBytes: drops.reduce((a, e) => a + e.size, 0),
    missingMustKeep
  };
}

/** 真实执行瘦身；缺必需文件时拒绝执行（防 runtime 结构变化误删），瘦身后复检 */
function applySlim(runtimeDir, opts = {}) {
  const rules = opts.rules || loadRules();
  const plan = planSlim(runtimeDir, rules);
  if (plan.missingMustKeep.length) {
    throw new Error('runtime 缺少必需文件，拒绝瘦身: ' + plan.missingMustKeep.join(', '));
  }
  if (!opts.dryRun) {
    for (const d of plan.drops) fs.rmSync(d.abs, { force: true });
  }
  const afterMissing = opts.dryRun
    ? []
    : rules.mustKeepRuntime.filter(p => !fs.existsSync(path.join(runtimeDir, p)));
  return { ...plan, afterMissing, applied: !opts.dryRun };
}

/** 产物级审计（纯函数，可 TDD）：APK 内文件名列表 → 必需文件齐全 + 瘦身项不残留 */
function auditApkEntries(names, rules = loadRules()) {
  const set = new Set(names);
  const missing = rules.apkMustKeep.filter(p => !set.has(p));
  const leftover = names.filter(n =>
    rules.apkForbiddenExact.includes(n) ||
    rules.apkForbiddenPrefix.some(p => n.startsWith(p))
  );
  return {
    ok: missing.length === 0 && leftover.length === 0,
    missing,
    leftover,
    totalEntries: names.length
  };
}

// ==================== CLI ====================
function printApply(report) {
  const mib = (report.freedBytes / 1024 / 1024).toFixed(2);
  console.log(`[apk-slim] 扫描 ${report.totalEntries} 文件 → 删除 ${report.drops.length}，保留 ${report.keeps.length}，释放 ${report.freedBytes} bytes (${mib} MiB)${report.applied ? '' : ' [dry-run]'}`);
  for (const d of report.drops.sort((a, b) => b.size - a.size).slice(0, 12)) {
    console.log(`  - ${String(d.size).padStart(9)} B  ${d.rel}`);
  }
  if (report.drops.length > 12) console.log(`  ... 其余 ${report.drops.length - 12} 项省略`);
  console.log(`[apk-slim] 必需文件复检: ${report.afterMissing.length ? 'FAIL ' + report.afterMissing.join(', ') : 'OK'}`);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'apply' || cmd === 'plan') {
    if (!arg) { console.error('用法: apk-slim.cjs apply|plan <runtimeDir>'); process.exit(2); }
    const report = cmd === 'apply' ? applySlim(arg) : { ...planSlim(arg), applied: false, afterMissing: [] };
    printApply(report);
    if (report.afterMissing.length) process.exit(1);
    return;
  }
  if (cmd === 'audit') {
    const input = fs.readFileSync(0, 'utf8');
    const names = input.split(/\r?\n/).filter(Boolean);
    const r = auditApkEntries(names);
    console.log(`[apk-slim][audit] APK 条目 ${r.totalEntries} · 必需文件 ${r.missing.length ? '缺失 ' + r.missing.join(', ') : '齐全'} · 瘦身残留 ${r.leftover.length}`);
    for (const n of r.leftover.slice(0, 10)) console.log(`  残留: ${n}`);
    if (!r.ok) process.exit(1);
    return;
  }
  if (cmd === 'classify') {
    console.log(classify(arg || ''));
    return;
  }
  console.error('用法: apk-slim.cjs apply|plan <runtimeDir> | audit (stdin: APK 文件名列表) | classify <rel>');
  process.exit(2);
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error(`[apk-slim] 失败: ${e.message}`); process.exit(1); }
}

module.exports = { loadRules, classify, planSlim, applySlim, auditApkEntries, RULES_PATH };
