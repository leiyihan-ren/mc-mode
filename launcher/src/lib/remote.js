/**
 * src/lib/remote.js — 运行平台检测与局域网远程控制封装
 *
 * 桌面端（Electron）：window.mcnext 存在，走 IPC。
 * 移动端（Capacitor APK）：无 window.mcnext，通过 HTTP 控制局域网内 PC 端 MC-Next。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export const isDesktop = typeof window !== 'undefined' && !!window.mcnext
export const isMobile = !isDesktop && Capacitor.isNativePlatform?.()

/* ---------- PC 地址存取 ---------- */
export function getPC() {
  try {
    return (localStorage.getItem('mcnext-remote-pc') || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  } catch { return '' }
}
export function setPC(ip) {
  localStorage.setItem('mcnext-remote-pc', (ip || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
}

/* ---------- 远程 RPC ---------- */
async function rpc(path, { method = 'GET', body } = {}) {
  const pc = getPC()
  if (!pc) throw new Error('尚未配置电脑 IP（设置 → 远程控制）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const r = await fetch(`http://${pc}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    return await r.json()
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接超时：请确认手机与电脑在同一 WiFi，且电脑端 MC-Next 已打开')
    throw new Error(`无法连接 ${pc}：${e.message}`)
  } finally {
    clearTimeout(timer)
  }
}

export const remoteApi = {
  status: () => rpc('/api/status'),
  clients: () => rpc('/api/clients'),
  logs: () => rpc('/api/logs'),
  launch: (payload) => rpc('/api/launch', { method: 'POST', body: payload }),
  stop: () => rpc('/api/stop', { method: 'POST' }),
  command: (text, server = false) => rpc(server ? '/api/server-command' : '/api/command', { method: 'POST', body: { text } })
}

/* ---------- Android Intent 唤起（原生插件） ---------- */
const IntentBridge = isMobile ? registerPlugin('IntentBridge') : null

export async function launchExternalApp(packageName) {
  if (!IntentBridge) throw new Error('仅 Android 环境可用')
  return IntentBridge.openApp({ packageName })
}

export async function isAppInstalled(packageName) {
  if (!IntentBridge) return false
  try { const r = await IntentBridge.isInstalled({ packageName }); return !!r.installed } catch { return false }
}

/** 常见 Java 版启动器包名 */
export const MC_LAUNCHERS = [
  { name: 'PojavLauncher', pkg: 'net.kdt.pojavlaunch' },
  { name: 'PojavLauncher（性能优化版）', pkg: 'net.kdt.pojavlaunch.debug' },
  { name: 'Fold Craft Launcher (FCL)', pkg: 'com.tungsten.fclauncher' },
  { name: 'Zaluppa Launcher / Hex Launcher', pkg: 'com.tom.rich2' }
]
