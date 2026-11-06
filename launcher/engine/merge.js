/**
 * merge.js — Jar 合并引擎（旧版 Forge universal + 原版 jar）
 * 语义（对齐 HMCL/PCL2）：
 *  - overlay(universal) 条目覆盖 base(原版) 同名条目（Forge 补丁类优先）
 *  - overlay 的 META-INF 签名文件(*.SF/*.RSA/*.DSA/MANIFEST.MF) 一律丢弃，保留 base 的
 *  - base 的 version.json 等元数据保留
 *  - 输出使用 STORE（不压缩）加速 IO，类冲突计数返回
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const SKIP_OVERLAY = /^META-INF\/(.*\.(SF|RSA|DSA)|MANIFEST\.MF)$/i;

/**
 * 合并两个 jar
 * @returns {{ entries:number, overwritten:number, added:number, out:string }}
 */
function mergeJars(baseJar, overlayJar, outJar) {
  const base = new AdmZip(baseJar);
  const overlay = new AdmZip(overlayJar);
  const baseNames = new Set(base.getEntries().map(e => e.entryName));

  const zip = new AdmZip();
  let overwritten = 0, added = 0, skippedSig = 0;

  // 1. base 全量（universal 不覆盖的保留）
  for (const e of base.getEntries()) {
    if (e.isDirectory) continue;
    zip.addFile(e.entryName, base.readFile(e), '', 0); // STORE
  }
  // 2. overlay 覆盖/新增
  for (const e of overlay.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (SKIP_OVERLAY.test(name)) { skippedSig++; continue; }
    if (baseNames.has(name)) overwritten++;
    else added++;
    // 覆盖：先删再加
    zip.deleteFile(name);
    zip.addFile(name, overlay.readFile(e), '', 0);
  }

  fs.mkdirSync(path.dirname(outJar), { recursive: true });
  zip.writeZip(outJar);
  const total = zip.getEntries().length;
  return { entries: total, overwritten, added, skippedSig, out: outJar };
}

/**
 * 从 Forge/NeoForge installer jar 中提取 universal jar
 * @returns {string} 提取出的 universal jar 路径
 */
function extractUniversalFromInstaller(installerJar, destDir) {
  let zip;
  try {
    zip = new AdmZip(installerJar);
  } catch (e) {
    throw new Error(`无法打开 installer jar: ${installerJar} (${e.message})`);
  }
  const uni = zip.getEntries().find(e => /universal\.jar$/.test(e.entryName));
  if (!uni) throw new Error(`installer 中未找到 universal.jar: ${installerJar}`);
  fs.mkdirSync(destDir, { recursive: true });
  const out = path.join(destDir, path.basename(uni.entryName));
  fs.writeFileSync(out, zip.readFile(uni));
  return out;
}

/** 计算 jar 内条目数（快速完整性探针） */
function countEntries(jarPath) {
  let zip;
  try {
    zip = new AdmZip(jarPath);
  } catch (e) {
    throw new Error(`无法打开 jar: ${jarPath} (${e.message})`);
  }
  return zip.getEntries().filter(e => !e.isDirectory).length;
}

module.exports = { mergeJars, extractUniversalFromInstaller, countEntries, SKIP_OVERLAY };
