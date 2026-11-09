/**
 * src/lib/nativeBridge.js — Android 大一统 UI 的 window.mcnext 实现层
 *
 * 桌面端由 electron/preload.cjs 的 contextBridge 注入 API；
 * 安卓端没有 Electron，本模块在 Capacitor WebView 里注入**同构**的 API：
 *   - 所有 invoke 方法 → McNextBridge.invoke({channel,argsJson,pc})
 *   - 所有事件方法   → McNextBridge 的 notifyListeners
 * channel 映射来自 src/lib/bridge-contract.json（由 preload.cjs 自动生成，单一数据源）。
 *
 * 落点（严格，不伪造结果）：
 *   native  → Java NativeCommandRouter → JNI / JvmBridge / GL4ES
 *   remote  → Java HttpURLConnection → PC 端 /api/rpc → 桌面真实 IPC handler
 *   remote 事件（非 game:log / game:exit）→ 通过可注入回调明确告知，绝不伪造数据
 *
 * 0.7.0 模块一：移除散落的 console.warn，改为 onUnsupportedEvent 回调，控制台零噪声。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import contract from '@/lib/bridge-contract.json'
import { getPC } from '@/lib/remote.js'

export const NATIVE_BRIDGE_FLAG = '__MCNEXT_NATIVE__'

/** 桌面 Electron 已有 preload；只有原生 Capacitor 环境才需要注入 */
export function shouldInstallNativeBridge() {
  if (typeof window === 'undefined') return false
  if (window.mcnext) return false
  try { return !!Capacitor.isNativePlatform?.() } catch { return false }
}

/**
 * 纯函数式核心：便于在 Node 单测里注入假 Bridge，验证全部指令的派发逻辑。
 * @param {object} deps { bridge, getPc, contractData, onUnsupportedEvent }
 */
export function createNativeApi(deps) {
  const {
    bridge,
    getPc = () => '',
    contractData = contract,
    onUnsupportedEvent = () => {}
  } = deps
  const nativeSet = new Set(contractData.native)
  const nativeEvents = new Set(contractData.nativeEvents)

  async function invokeChannel(channel, args = []) {
    if (!contractData.invoke.includes(channel)) {
      return { ok: false, error: `未知指令 ${channel}（不在 preload 契约白名单内）` }
    }
    const pc = nativeSet.has(channel) ? '' : (getPc() || '')
    try {
      // 用 argsJson 字符串而非 JS 数组：避免 Capacitor 各版本 getArray() API 差异，
      // Java 侧直接 new JSONArray(argsJson) 还原，参数个数/顺序与桌面 IPC 完全一致。
      const r = await bridge.invoke({ channel, argsJson: JSON.stringify(args), pc })
      if (!r || typeof r.result !== 'string') {
        return { ok: false, error: '原生桥返回格式异常（缺少 result 字符串）' }
      }
      return JSON.parse(r.result)
    } catch (e) {
      return { ok: false, error: `原生桥调用失败: ${e && e.message ? e.message : String(e)}` }
    }
  }

  const api = {
    platform: 'android',
    isRoot: false,
    __native: true,
    invokeChannel,
    /** 供 UI 判断某条指令是否需要 PC 在线 */
    isRemoteChannel: (channel) => !nativeSet.has(channel) && contractData.invoke.includes(channel)
  }

  for (const [method, channel] of Object.entries(contractData.methodMap)) {
    api[method] = (...args) => invokeChannel(channel, args)
  }

  for (const [method, channel] of Object.entries(contractData.eventMethodMap)) {
    api[method] = (cb) => {
      if (!nativeEvents.has(channel)) {
        // 不伪造：远程事件需要 PC 端事件总线，当前只做明确告知（由调用方决定如何呈现）
        onUnsupportedEvent(channel)
        return () => {}
      }
      let handle = null
      let removed = false
      const p = bridge.addListener(channel, (ev) => {
        if (typeof cb !== 'function') return
        try { cb(JSON.parse(ev && ev.payload != null ? ev.payload : '{}')) } catch { /* 单条坏事件不打断订阅 */ }
      })
      if (p && typeof p.then === 'function') p.then(h => { if (removed && h) h.remove(); else handle = h }).catch(() => {})
      return () => { removed = true; if (handle && typeof handle.remove === 'function') handle.remove() }
    }
  }
  return api
}

/** 在 WebView 中安装 window.mcnext（幂等） */
export function installNativeBridge() {
  if (!shouldInstallNativeBridge()) return null
  const Bridge = registerPlugin('McNextBridge')
  const api = createNativeApi({ bridge: Bridge, getPc: getPC })
  window.mcnext = api
  window[NATIVE_BRIDGE_FLAG] = true
  return api
}
