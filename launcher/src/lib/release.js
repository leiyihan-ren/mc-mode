/**
 * 真实 GitHub Release 下载地址（绝对 URL，无相对路径）。
 * 数据源 config/release.json，由交付流程创建同名 tag / 同名 assets 后即为有效直链。
 */
import cfg from '../../config/release.json'

const base = `${cfg.repo}/releases/download/${cfg.tag}`

export const RELEASE = {
  page: `${cfg.repo}/releases/tag/${cfg.tag}`,
  repo: cfg.repo,
  tag: cfg.tag,
  appImage: `${base}/${cfg.assets.appImage}`,
  tarGz: `${base}/${cfg.assets.tarGz}`,
  apk: `${base}/${cfg.assets.apk}`,
  source: `${base}/${cfg.assets.source}`
}

/** 用系统浏览器/外部打开（Electron 里由 shell.openExternal 处理，浏览器里直接 window.open） */
export function openDownload(url) {
  if (window.mcnext && typeof window.mcnext.openExternal === 'function') {
    window.mcnext.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
