/**
 * src/services/index.js — Service 层统一出口
 *
 * 领域归属（与 electron/preload.cjs 的注释分组一致，底层全部走同一个 api 门面）：
 *   game/repo/download/instance/console/jvm/appearance → 启动与运行
 *   auth/skin                                          → 账号与外观
 *   mods/modpack/modrinth                              → 模组生态
 *   world/server/lan/net                              → 世界与联机
 *   crash/java/update/app                             → 诊断、运行时与分发
 *
 * 页面统一 `import { api } from '@/services'`。
 * 这里只做**聚合与再导出**，不复制 channel 名、不改写调用语义：
 * 保持 v0.6.0 的全部行为不变，仅把底层通信收敛到单一出入口。
 */
export {
  api,
  getBridge,
  isBridgeAvailable,
  getPlatform,
  isNativeBridge,
  invoke,
  subscribe,
  getSubscriptionStats
} from './bridge.js'

/** 0.9.0 模块二C：内存守护工具统一从 Service 层出口暴露给 UI */
export {
  BUFFER_LIMITS,
  appendBounded,
  renderWindow,
  createSubscriptionSet
} from '@/lib/memory.mjs'

/** 局域网远程控制与平台检测本就是独立 Service，从 lib 再导出，保持单一入口 */
export {
  remoteApi,
  getPC,
  setPC,
  isMobile,
  isDesktop,
  launchExternalApp,
  isAppInstalled,
  MC_LAUNCHERS
} from '@/lib/remote.js'
