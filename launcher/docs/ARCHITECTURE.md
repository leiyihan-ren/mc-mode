# MC-Next 架构与模块解耦说明（v0.9.0）

> 本文档描述**真实代码结构**，用于降低跨端维护成本。所有约束均有对应测试守卫
> （`tests/architecture.test.cjs` / `tests/native-bridge.test.cjs` / `tests/ipc-listener-leak.test.cjs`
> / `tests/asarSlim.test.cjs`），不是设计愿景。
> 最近更新：0.9.0 通宵加固（IPC 订阅注销修复 / asar 瘦身 / AI 可读崩溃摘要）。

## 一、进程与分层模型

MC-Next 同时存在 **三种运行时**，共享同一套 React 渲染层源码（`src/`）：

| 运行时 | 宿主 | 底层桥注入方 | 渲染层来源 |
| --- | --- | --- | --- |
| 桌面 Electron | Electron 主进程 + Chromium | `electron/preload.cjs` 的 `contextBridge` | `dist/`（Vite 构建） |
| Android 原生 | Capacitor WebView | `src/lib/nativeBridge.js` 注入同构 `window.mcnext` | `dist/` → `www/`（同一份产物） |
| 纯浏览器预览 | 浏览器 | 无桥（`isBridgeAvailable()===false`） | `dist/` |

依赖方向（**单向，禁止反向**）：

```
src/features/**（页面/组件，纯 UI）
        │  只能通过 @/services
        ▼
src/services/bridge.js（唯一门面）  ──读取──▶  src/lib/bridge-contract.json（契约）
        │  调用 window.mcnext
        ├─────────────── 桌面：electron/preload.cjs（contextBridge 白名单）──▶ electron/ipc.cjs ──▶ engine/**
        └─────────────── 安卓：src/lib/nativeBridge.js（Capacitor 插件）
                                    ├─ native channel ─▶ Java NativeCommandRouter ─▶ JNI / JvmBridge / GL4ES
                                    └─ remote channel ─▶ HTTP /api/rpc ─▶ PC 端真实 IPC handler
```

**守卫**：`features/` 下零 `window.mcnext`、零相对 import、零 `console.*`；仅
`services/bridge.js` / `lib/nativeBridge.js` / `lib/remote.js` 允许接触底层桥。
（`tests/architecture.test.cjs`）

## 二、单一数据源（Single Source of Truth）

| 数据 | 唯一来源 | 自动派生 | 防漂移守卫 |
| --- | --- | --- | --- |
| IPC 指令契约（102 invoke / 17 event） | `electron/preload.cjs` | `tools/gen-bridge-contract.cjs` → `engine/bridge/contract.cjs`、`src/lib/bridge-contract.json`、`android/.../BridgeContract.java` | `tests/native-bridge.test.cjs` 逐一比对 preload 与三端产物 |
| 版本号 / Release tag / 资产名 | `package.json` + `config/release.json` | `upload-release.py` / `publish-source.py` / `gen-latest-yml.cjs` / `build-unified-apk.sh` / 安卓 UA 全部读配置 | `tests/updater.test.cjs` + 发布前资产校验（缺一即拒绝发布） |
| JVM 崩溃规则 | `engine/crash/analyzer.cjs` 的 `RULES` | `guardian.cjs`（流式拦截）复用同一规则源 | `tests/crash.test.cjs` / `tests/guardian.test.cjs` |
| G1GC 调优预设 | `engine/appearance.cjs` 的 `G1_BASE` | `jvm/monitor.cjs` 的 `recommendJvm` 复用 | `tests/jvm-monitor.test.cjs` |
| 高频缓冲上限 | `src/lib/memory.mjs` 的 `BUFFER_LIMITS` | 各页面 + 订阅仪表共用 | `tests/memoryLeak.test.cjs` |

> 设计约束：**新增 IPC channel 只需改 `preload.cjs` 并重跑生成器**，不得手工编辑三端契约产物。
> 0.9.0 修复 IPC 订阅注销时特意保持 17 个 `on*` 方法字面量原样，正是为了让契约生成器正则零改动。

## 三、双端桥接与通信隔离

### 桌面（contextBridge）
`main.cjs` 的 `BrowserWindow` 强制 `contextIsolation:true` / `nodeIntegration:false`，
渲染层**拿不到** `require` / `process` / `ipcRenderer`。`preload.cjs` 只暴露契约白名单方法，
且 0.9.0 起每个 `on*` 订阅都返回幂等的 `off()`（真实调用 `ipcRenderer.removeListener`）。

> **0.9.0 修复的真实缺陷**：此前 `on*` 返回的是 `ipcRenderer.on()` 的返回值
> （EventEmitter 的 `this`，一个 object 而非函数），`services/bridge.js` 的
> `wrapSubscription` 判断 `typeof off === 'function'` 恒为 false → 监听器永不注销。
> 订阅仪表因只统计 registry 而显示「归零」，属**假绿**。现在仪表归零与底层监听器
> 归零同时成立，由 `tests/ipc-listener-leak.test.cjs` 用真实 EventEmitter 语义验证
> （2000 轮挂机 `listenerCount` 恒回 0）。

### 安卓（Capacitor）
`nativeBridge.js` 生成与桌面**同构**的 `window.mcnext`：
- `invoke` 全部走 `McNextBridge.invoke({channel, argsJson, pc})`，参数用 JSON 字符串规避
  Capacitor 各版本 `getArray()` 差异；
- 未知 channel 在 JS 层直接拒绝，Java 侧 `BridgeContract` 白名单二次校验（防任意指令注入）；
- `native` channel 直达 JNI / JvmBridge / GL4ES；`remote` channel 转发 PC `/api/rpc`，
  **未配置 PC 时返回明确错误，不伪造结果**；
- native 事件真实订阅并解析 payload，remote 事件通过 `onUnsupportedEvent` 明确告知不支持，
  不伪造数据；所有订阅返回可注销函数，与桌面语义一致。

### 渲染降级链（GL4ES / ANGLE / VirGL / Zink）
`android/app/src/main/java/.../RenderBackend.java` 为纯 Java、可 JVM 单测：
`GpuProbe` 真实探测 GPU 厂商/Vulkan 能力 → `autoSelect` 按厂商选择 → `resolve` 支持手动指定
→ `fallbackChain` 以 GL4ES 兜底、无重复 → `nativeLibs()`/`jvmProperties()` 保证环境变量与
GL 库名同源。`NativeCommandRouter` 启动失败时按链自动降级并写回 cfg。
守卫：`tests/architecture.test.cjs` + `android/app/src/test/.../RenderBackendTest.java`。

## 四、崩溃防线（四层，从进程到 UI）

```
L1 桌面进程流   guardian.cjs     逐行 stderr/stdout，STRONG 立即上报 / 上下文型防误杀 / exit 兜底
L2 桌面 IPC     ipcGuard.cjs     包裹全部 handler，致命错误归一化 + send('game:crash')，绝不 rethrow
L3 安卓 JNI     bridge_commands.c 指令窗口内 sigaction + TLS sigsetjmp/siglongjmp + async-signal-safe marker
L4 安卓 Java    AndroidCrashGuard.java  logcat 同源守护，synchronized 并发安全，catch Throwable
                     │
                     ▼  双端统一 game:crash → CrashDialog（人类可读弹窗 + 强制复位 gameRunning）
前端兜底：services/bridge.js 广播 mcnext:bridge-fatal（主通道失效时仍能弹窗）
AI 可读：  engine/crash/aiDigest.cjs 把 analyzer/guardian/logCleaner/ipcGuard 四路输出
           聚合成脱敏、有界、结构化的 Markdown + JSON（含 hs_err 原生帧解析）
```

`aiDigest.cjs` 是**纯函数、零侵入**：不新增 IPC channel、不改契约、不改 UI，只把已有能力
汇总为 AI 可直接消费的格式。诚实边界：未识别特征留空、不臆造堆栈、脱敏 token/UUID/IP/邮箱。

## 五、依赖与打包边界（0.9.0 瘦身）

| 依赖 | 位置 | 原因 |
| --- | --- | --- |
| `adm-zip` | **dependencies** | 主进程 `engine/` 11 个文件真实 require，运行时必需 |
| `three` / `skinview3d` / `@capacitor/core` | devDependencies | 仅 `src/` 渲染层 import，Vite 已完整打进 `dist`（零 bare import） |
| `axios` + 传递依赖 | devDependencies | 全仓零 import（主进程用 Node 原生 `fetch`） |

`electron-builder` 按 `dependencies` 自动带入 node_modules。收敛后：
**app.asar 23.8MB → 1.44MB（-94%）**，解包 27M → 1.6M，node_modules 仅剩 `adm-zip`。
`build.files` 白名单只含 `electron/ engine/ config/ dist/ package.json`（不含 node_modules 通配）。
守卫：`tests/asarSlim.test.cjs`（防前端库回退进 dependencies、防 dist 残留 bare import）。

## 六、内存不变量（挂机 24h 等价）

`src/lib/memory.mjs` 提供 `BUFFER_LIMITS` / `appendBounded` / `renderWindow` /
`createSubscriptionSet` / `subscriptionRegistry` / `wrapSubscription`：
- 所有高频缓冲有硬上限，超界丢弃最旧；日志区 DOM 渲染窗口 500 行；
- 每个订阅在 registry 记账，`off` 幂等注销，组件卸载必须 `disposeAll()`；
- `getSubscriptionStats()` 暴露 `total / created / disposed / peak` 供挂机断言。

**诚实边界**：真实 24h heap 曲线需 Electron 运行时 + 真机观测，沙盒无 GUI，
用「2000 次 mount/unmount + 8000 订阅 + 10 万日志」验证**结构性不变量**（活跃订阅恒回 0、
缓冲/渲染窗口恒有上界、不单调增长），不伪造内存数字。

## 七、测试与构建入口

| 命令 | 作用 |
| --- | --- |
| `npm test` | `node --test tests/*.test.cjs`，全量 526/526（0.9.0） |
| `npm run test:e2e` | 5 场景真实下载/安装/启动全流程（含官方源多源降级） |
| `npm run build:renderer` | Vite 构建 dist（83 modules，prod 剥离 console） |
| `npm run build` | dist + electron-builder AppImage / tar.gz |
| `node tools/gen-bridge-contract.cjs` | 从 preload 重生成三端契约 |
| `MCNEXT_BUILD_TYPE=release bash tools/build-unified-apk.sh` | 正式签名大一统 APK |
| `bash tools/build-signed-desktop.sh check` | 报告签名凭据/平台状态（不伪造签名） |
| `cd android && ./gradlew testDebugUnitTest` | 安卓 JVM 单测（降级链/崩溃守护） |
