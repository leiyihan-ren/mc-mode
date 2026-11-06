/**
 * 真实 GitHub Release 下载地址（绝对 URL，无相对路径）。
 * 数据源 config/release.json，由交付流程创建同名 tag / 同名 assets 后即为有效直链。
 *
 * GitHub 官方直链在国内网络常出现连接挂起，因此按钮默认走加速镜像
 * （gh-proxy.com，实测对这四个 asset 均返回 206 可下载），官方直链作为备用同时展示。
 */
import cfg from '../../config/release.json'

const base = `${cfg.repo}/releases/download/${cfg.tag}`
const mirror = (url) => (cfg.mirror ? cfg.mirror + url : url)
const official = {
  repo: cfg.repo,
  tag: cfg.tag,
  page: `${cfg.repo}/releases/tag/${cfg.tag}`,
  appImage: `${base}/${cfg.assets.appImage}`,
  tarGz: `${base}/${cfg.assets.tarGz}`,
  apk: `${base}/${cfg.assets.apk}`,
  source: `${base}/${cfg.assets.source}`
}

export const RELEASE = {
  ...official,
  mirrorAppImage: mirror(official.appImage),
  mirrorTarGz: mirror(official.tarGz),
  mirrorApk: mirror(official.apk),
  mirrorSource: mirror(official.source),
  mirrorPrefix: cfg.mirror || ''
}

/** 用系统浏览器/外部打开（Electron 里由 shell.openExternal 处理，浏览器里直接 window.open） */
export function openDownload(url) {
  if (window.mcnext && typeof window.mcnext.openExternal === 'function') {
    window.mcnext.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
