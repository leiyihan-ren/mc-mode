/**
 * installerPrefetch.js — Installer 依赖预下载（多源镜像降级）
 *
 * 背景：Forge/NeoForge installer 的 --installServer 流程会从官方 maven
 * （maven.neoforged.net 等）下载数百个依赖；在镜像网络环境下直连官方源
 * 经常超时/阻断。本模块先把 install_profile.json + version.json 声明的
 * 全部 libraries 预下载到本地 maven 目录（走 BMCLAPI 镜像），installer
 * 运行时发现本地文件 checksum 有效即跳过下载，静默安装成功率大幅提升。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { downloadFile } = require('./http');
const { BMCL } = require('./sources');

/**
 * 预下载 installer 声明的全部 libraries
 * @param installerJar installer jar 路径
 * @param libsDir 本地 maven 仓库目录（installer 约定为 <workDir>/libraries）
 * @param opts.onProgress(optional) 每下载一个回调
 * @returns {{total, ok, fail, failures: Array<{path, error}>}}
 */
async function prefetchInstallerLibraries(installerJar, libsDir, opts = {}) {
  fs.mkdirSync(libsDir, { recursive: true });
  const zip = new AdmZip(installerJar);

  // 合并 install_profile.json（安装期库）与 version.json（运行期库）两份清单
  const seen = new Set();
  const arts = [];
  for (const name of ['install_profile.json', 'version.json']) {
    let profile;
    try { profile = JSON.parse(zip.readAsText(name)); } catch { continue; }
    for (const lib of (profile.libraries || [])) {
      const a = lib.downloads && lib.downloads.artifact;
      if (!a || !a.path || seen.has(a.path)) continue;
      seen.add(a.path);
      arts.push(a);
    }
  }

  let ok = 0, fail = 0;
  const failures = [];
  for (const a of arts) {
    const dest = path.join(libsDir, a.path);
    if (fs.existsSync(dest)) { ok++; continue; } // 已预置则跳过
    try {
      await downloadFile(`${BMCL}/maven/${a.path}`, dest, {
        expectedSha1: a.sha1, timeoutMs: 60000, retries: 2
      });
      ok++;
    } catch (e) {
      fail++;
      failures.push({ path: a.path, error: String(e && e.message || e).slice(0, 140) });
    }
    if (opts.onProgress) opts.onProgress(ok + fail, arts.length);
  }
  return { total: arts.length, ok, fail, failures };
}

module.exports = { prefetchInstallerLibraries };
