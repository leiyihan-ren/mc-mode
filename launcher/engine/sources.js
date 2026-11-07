/**
 * sources.js — 多源降级配置（魔鬼级降级链）
 * 官方源 -> BMCLAPI 镜像 -> 极端重试
 * 纯函数模块，无 IO，可独立单测。
 */
'use strict';

const BMCL = 'https://bmclapi2.bangbang93.com';

/** 官方源清单（按用途分组） */
const OFFICIAL = {
  versionManifest: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  pistonMeta: 'https://piston-meta.mojang.com/v1/packages',
  pistonData: 'https://piston-data.mojang.com/v1/objects',
  launcher: 'https://launcher.mojang.com',
  libraries: 'https://libraries.minecraft.net',
  forgeMaven: 'https://maven.minecraftforge.net',
  neoforgeMaven: 'https://maven.neoforged.net/releases',
  fabricMaven: 'https://maven.fabricmc.net',
  fabricMeta: 'https://meta.fabricmc.net',
  quiltMaven: 'https://maven.quiltmc.org/repository/release',
  quiltMeta: 'https://meta.quiltmc.org'
};

/**
 * 把任意官方 URL 映射为镜像候选列表（含原 URL 作为首选）。
 * 映射规则：
 *  - mojang.com 系列 -> BMCLAPI 对应路径
 *  - libraries.minecraft.net / maven.* -> BMCLAPI /maven/<原路径>
 *  - 其他（无镜像）-> 仅原 URL
 */
function mirrorCandidates(url) {
  let u;
  try { u = new URL(url); } catch { return [url]; }
  const list = [url];
  const host = u.hostname;
  const path = u.pathname.replace(/^\//, '') + (u.search || '');

  const push = (p) => { if (p) list.push(BMCL + '/' + p.replace(/^\//, '')); };

  if (host === 'launchermeta.mojang.com') {
    // 版本清单镜像
    push('mc/game/version_manifest_v2.json');
  } else if (host === 'piston-meta.mojang.com') {
    // /v1/packages/<sha>/<id>.json -> /version/<id>/json
    const m = path.match(/^v1\/packages\/[0-9a-f]+\/(.+)\.json$/);
    if (m) push(`version/${m[1]}/json`);
  } else if (host === 'launcher.mojang.com') {
    // 客户端/服务端 jar: /download/<...>.jar 无法通用映射，交由调用方显式传入 BMCL 直链
  } else if (host === 'piston-data.mojang.com') {
    // assets 对象: /v1/objects/<sha>/<path> -> /assets/<path>
    const m = path.match(/^v1\/objects\/[0-9a-f]{40}\/(.+)$/);
    if (m) push(`assets/${m[1]}`);
  } else if (host === 'libraries.minecraft.net') {
    push(`maven/${path}`);
  } else if (/maven\./.test(host)) {
    // maven.minecraftforge.net / maven.fabricmc.net / maven.neoforged.net / maven.quiltmc.org
    push(`maven/${path}`);
  }
  // 去重保序
  return [...new Set(list)];
}

/** BMCLAPI 客户端/服务端直链 */
function bmclJarUrl(versionId, kind /* 'client' | 'server' */) {
  return `${BMCL}/version/${versionId}/${kind}`;
}

/** BMCLAPI assets 直链 */
function bmclAssetUrl(relPath) {
  return `${BMCL}/assets/${relPath}`;
}

/**
 * 【0.4.0 模块三】镜像优先候选链：BMCLAPI 首选、Mojang 官方源备用。
 *
 * 复用 mirrorCandidates 的真实映射规则，不重复维护一份映射表：
 *   mirrorCandidates(url) = [官方原 URL, BMCLAPI 镜像...]
 *   mirrorFirstCandidates = [BMCLAPI 镜像..., 官方原 URL]
 * 无可用镜像时（未知主机 / 已是 BMCLAPI 直链）原样返回 [url]，不做任何编造。
 */
function mirrorFirstCandidates(url) {
  const c = mirrorCandidates(url);
  if (c.length <= 1) return c;
  return [...c.slice(1), c[0]];
}

/** 当前下载源策略（供 UI 展示，真实列出优先级，不含任何假状态） */
const SOURCE_POLICY = {
  strategy: 'mirror-first',
  primary: { id: 'bmclapi', name: 'BMCLAPI', url: BMCL, note: '国内镜像，首选' },
  fallback: [
    { id: 'mojang-libraries', name: 'Mojang 官方（依赖库）', url: OFFICIAL.libraries },
    { id: 'mojang-piston-data', name: 'Mojang 官方（资源对象）', url: OFFICIAL.pistonData },
    { id: 'mojang-launcher', name: 'Mojang 官方（客户端/服务端）', url: OFFICIAL.launcher }
  ],
  retry: '指数退避（exponential backoff），失败逐源切换，SHA-1 校验不通过自动换源',
  note: 'BMCLAPI 与 Mojang 官方均为真实可用源；顺序由 engine/http.js 的 preferMirror 控制，无网络时如实报错'
};

module.exports = {
  OFFICIAL, BMCL, SOURCE_POLICY,
  mirrorCandidates, mirrorFirstCandidates, bmclJarUrl, bmclAssetUrl
};
