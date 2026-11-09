/**
 * src/services/bridge.js — 底层桥接唯一门面（Service 层内核）
 *
 * 桌面端由 electron/preload.cjs 的 contextBridge 注入 window.mcnext；
 * Android 端由 src/lib/nativeBridge.js 注入同构实现。
 * 本模块是渲染层**唯一**允许接触 window.mcnext 的地方：
 *   - 统一可用性判定（Electron / Capacitor / 纯浏览器预览）
 *   - 统一调用错误归一化：底层缺失时返回明确的拒绝，而不是抛 TypeError 卡死页面
 *   - 由 preload 契约白名单自动生成同构 api，避免手工维护 100+ 方法
 *
 * 页面与组件一律通过 `@/services` 访问底层，不再散落 window.mcnext。
 * 契约来源：src/lib/bridge-contract.json（tools/gen-bridge-contract.cjs 自动生成，单一数据源）。
 *
 * 0.9.0 模块一C：底层 IPC / JNI 致命错误全局兜底。
 * 主进程 ipcGuard 抛出的原生层崩溃会 send('game:crash')（主通道），同时把完整 report
 * 随错误对象返回；本层再广播 mcnext:bridge-fatal（兜底通道），保证 remote RPC /
 * Android polyfill / 主通道失效时 CrashDialog 仍能弹窗，而不是启动器闪退。
 */
import contract from '@/lib/bridge-contract.json'
import { subscriptionRegistry, wrapSubscription } from '@/lib/memory.mjs'

/** 取得真实底层 API。惰性读取，兼容 nativeBridge 在 render 前才注入的时序。 */
export function getBridge() {
  if (typeof window === 'undefined') return null
  return window.mcnext || null
}

export function isBridgeAvailable() {
  return !!getBridge()
}

/** 平台判定集中在此，页面不再各自读 window.mcnext.platform */
export function getPlatform() {
  return getBridge()?.platform || 'browser'
}

export function isNativeBridge() {
  return !!getBridge()?.__native
}

/**
 * 0.9.0 模块一C：把底层返回的致命错误归一化为 CrashDialog 可直接渲染的报告。
 * ipcGuard 已随错误对象带回完整 report 时优先复用（保证双通道去重 key 一致）。
 * 普通业务失败（fatal 非 true）一律返回 null，绝不误弹崩溃窗。
 */
function fatalDetail(err) {
  if (!err) return null
  if (err.report && err.report.ok === false) return err.report
  if (err.fatal !== true) return null
  return {
    ok: false,
    code: err.code || 'NATIVE_CRASH',
    title: err.title || '底层原生通信崩溃（IPC / JNI / 渲染）',
    severity: err.severity || 'fatal',
    reason: err.error || err.message || err.reason || '未知底层致命错误',
    suggestions: err.suggestions || [
      '本次操作已被安全拦截，启动器不会闪退，可重试或切换版本',
      '尝试切换渲染后端（GL4ES / VirGL / Zink）',
      '检查 Java 版本与 natives 库是否匹配当前游戏版本'
    ],
    evidence: err.evidence || [],
    human: err.human || '',
    source: err.source || 'bridge',
    stream: err.stream || 'ipc',
    at: Date.now()
  }
}

/** 广播给全局兜底弹窗；浏览器预览 / 无 CustomEvent 时静默跳过，绝不影响原错误传播。 */
function broadcastFatal(detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    const Ev = window.CustomEvent || globalThis.CustomEvent
    if (typeof Ev !== 'function') return
    window.dispatchEvent(new Ev('mcnext:bridge-fatal', { detail }))
  } catch { /* 兜底广播绝不掩盖原错误 */ }
}

/**
 * 调用一个 invoke 方法。
 * 底层缺失 / 方法未注册时返回明确的拒绝 Promise，配合模块四「永不崩溃」。
 * 成功结果原样透传；仅当结果或拒绝携带 fatal 标记时额外广播兜底弹窗。
 */
export function invoke(method, args = []) {
  const b = getBridge()
  if (!b) return Promise.reject(new Error('[MC-Next] 底层桥接未就绪（非桌面 / 安卓运行环境）'))
  if (typeof b[method] !== 'function') {
    return Promise.reject(new Error(`[MC-Next] 底层未注册方法：${method}`))
  }
  try {
    return Promise.resolve(b[method](...args)).then(
      (r) => {
        const d = fatalDetail(r)
        if (d) broadcastFatal(d)
        return r
      },
      (e) => {
        const d = fatalDetail(e)
        if (d) broadcastFatal(d)
        throw e
      }
    )
  } catch (e) {
    const d = fatalDetail(e)
    if (d) broadcastFatal(d)
    return Promise.reject(e)
  }
}

/**
 * 事件订阅：底层缺失时返回 noop 取消函数，保证组件卸载不抛错。
 * 0.9.0 模块二C：每个活跃订阅在 registry 记账，off 幂等注销；
 * 页面反复 mount/unmount 若遗漏 cleanup，getSubscriptionStats().total 会单调增长而被挂机测试捕获。
 */
export function subscribe(method, cb) {
  const b = getBridge()
  if (!b || typeof b[method] !== 'function') return () => {}
  try {
    const off = b[method](cb) || (() => {})
    return wrapSubscription(off, method)
  } catch {
    return () => {}
  }
}

/** 挂机可观测：当前活跃订阅统计（total / byMethod / created / disposed / peak） */
export function getSubscriptionStats() {
  return subscriptionRegistry.stats()
}

/** 按契约白名单生成同构 api：方法名与 preload 完全一致，零改名、零行为差异。 */
function buildApi() {
  const api = {}
  for (const method of Object.keys(contract.methodMap || {})) {
    api[method] = (...args) => invoke(method, args)
  }
  for (const method of Object.keys(contract.eventMethodMap || {})) {
    api[method] = (cb) => subscribe(method, cb)
  }
  Object.defineProperties(api, {
    platform: { get: getPlatform, enumerable: true },
    isRoot: { get: () => !!getBridge()?.isRoot, enumerable: true },
    __native: { get: isNativeBridge, enumerable: true },
    isAvailable: { value: isBridgeAvailable, enumerable: true },
    isRemoteChannel: {
      value: (channel) => {
        const b = getBridge()
        if (b && typeof b.isRemoteChannel === 'function') return b.isRemoteChannel(channel)
        const natives = new Set(contract.native || [])
        return (contract.invoke || []).includes(channel) && !natives.has(channel)
      },
      enumerable: true
    }
  })
  return Object.freeze(api)
}

export const api = buildApi()
export default api
