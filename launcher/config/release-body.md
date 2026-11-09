MC-Next v0.9.0 — 双端高阶功能集成与底层架构加固。

本版承接 v0.6.0（商业级）/ v0.7.0（纯重构与稳定性），把最终双端产物与 Release 一次性收敛发布。全量 **526 / 526** Node 断言通过，Gradle JVM 单测 **67 / 67**，E2E **5 / 5** 全链路通过。

## 模块一：新增高阶功能

**1. 多实例完全隔离**
`engine/isolation.cjs` 新增激活会话（`ACTIVE_FILE` 原子 rename）、`switchInstance`、`gameDirForLaunch`、`verifyIsolation`；启动链路从硬编码 `GAME_DIR` 改为按实例解析 `mods / config / saves`，1.12.2 与 1.20.1 物理隔离；前端 `InstanceContext` + CSS 过渡实现一键平滑切换；启动链路隔离 E2E 5/5 验证 JVM `gameDir` 真实指向隔离目录。

**2. 下载节点智能测速**
`engine/net/speedtest.cjs` 并发探测 Mojang 官方 / BMCLAPI 镜像的 Range 首字节延迟，按可用 + 延迟排序，TTL 缓存，无公网时如实报错不伪造延迟；`engine/net/parallelDownload.cjs` 实现单文件分块并发下载、`.part` 断点续传、逐段长度校验、顺序合并、整体 SHA1、原子 rename 与 fallback；`download:benchmark` / `download:smart` 接入 IPC，下载页提供测速面板与智能下载开关。契约 100 → 102 invoke。

**3. JNI 通信防崩溃防线（四层）**
- L1 桌面：`engine/crash/ipcGuard.cjs` 包裹所有 IPC handler（含 `/api/rpc`），致命错误归一化为结构化报告并 `send('game:crash')`，绝不 rethrow 卡死页面。
- L2 前端：Service 层 `mcnext:bridge-fatal` 兜底广播 + `CrashDialog` 双通道去重弹窗。
- L3 Android JNI：`bridge_commands.c` 在 dispatch 指令窗口内临时 `sigaction` 接管致命信号，TLS `sigsetjmp/siglongjmp` 只回跳同线程、窗口外恢复原 handler 不破坏 ART；async-signal-safe 落盘崩溃标记供下次启动补发；JNI `ExceptionCheck/Clear`；`crashSelfTest` 受控自检指令。
- Java 侧纯 JVM 单测 `NativeCrashReport` 8 项，`catch Throwable` 覆盖 Error。

## 模块二：工程化与性能极限优化

**1. Electron 主进程减负**
真实剖析先行：顶层 30+ 引擎模块串行 require 合计仅 ~16ms，冷启动大头是同步磁盘 IO 与 Electron/Chromium，不虚报毫秒数。22 处同步 IO 全改 `await fs.promises.*`；17 个非核心功能服务用 `lazy.cjs` Proxy 惰性加载（调用点零改动、测试 stub 照常命中）；局域网遥控服务延迟到首帧后惰性 require + `setImmediate`；`bootMetrics.cjs` 输出冷启动各阶段结构化日志（stubbed Electron 实测首帧 56.22ms / 预算 2000ms）。

**2. 安卓端体积瘦身（真实 -35.6%）**
审查结论不删功能依赖凑数字：53 个 `.so` 已全部 strip、且 `libOSMesa` / `libvulkan_freedreno` 是渲染降级链真实依赖；`lib/modules` 46.58 MiB 为 JRE 核心，jlink 裁剪漏模块会致 ClassNotFound 且无真机可验证，明确不做。白名单式剔除 42 个 JDK 编译期文件（`ct.sym` / `man/` / CDS classlist / JFR / JMX+SDP / bin 开发工具）。**诚实发现**：仅删 assets 时 APK 文件字节几乎不变（zipalign 为未压缩 `.so` 保持页对齐，把 5.87 MiB 用 padding 补回）；启用 `useLegacyPackaging` 压缩 `.so` 后同快照实测 **105.84 MiB → 68.19 MiB（-37.65 MiB / -35.6%）**，与 `AndroidManifest extractNativeLibs=true` 及代码依赖 `nativeLibraryDir + dlopen` 的设计意图一致。产物级审计（必需文件齐全 + 瘦身项零残留）接入构建脚本。

**3. 内存泄漏排查**
修复 4 处事件订阅缺 cleanup（App / DownloadPage / ConsolePage / JavaManagerPage）、3 处 `setTimeout` 无清理；`src/lib/memory.mjs` 统一有界缓冲（`BUFFER_LIMITS` / `appendBounded` / `renderWindow`）、订阅收集器与运行时订阅仪表；日志区 DOM 限制为 500 行渲染窗口。24h 等价挂机压力：2000 次 mount/unmount（8000 订阅）+ 10 万条日志，断言活跃订阅恒回 0、`created == disposed`、峰值恒等于单次挂载订阅数、缓冲与渲染窗口恒有上界，全程不单调增长。

## 通宵加固（终局集成阶段新增）

在 M1A～M2C 六大模块之上，终局集成阶段又做了四项**真实、可验证**的加固（均有专项测试守卫）：

**1. 修复桌面端 IPC 订阅的真实内存泄漏（假绿修复）**
审查 Electron / Capacitor 双端通信隔离时发现：`preload.cjs` 的 17 个 `on*` 订阅方法把
`ipcRenderer.on()` 的返回值（EventEmitter 的 `this`，object）透出，而非可注销函数；
`services/bridge.js` 的 `wrapSubscription` 因此永远不调用 `removeListener`，每轮 mount/unmount
都残留一个真实监听器，而订阅仪表显示「归零」属假绿。改为局部包装 `ipcRenderer.on`、
让每个 `on*` 返回幂等 `off()`（精确 `removeListener` 同一 handler）；安卓 polyfill 早已正确，
双端自此语义一致。契约方法字面量零改动 → 102/17 契约三端产物零漂移。
`tests/ipc-listener-leak.test.cjs` 用真实 EventEmitter 验证 2000 轮挂机 `listenerCount` 恒回 0。

**2. 桌面安装包 asar 瘦身 -94%**
审查发现 `three`(13M)/`skinview3d`(9.4M)/`@capacitor/core`/`axios`(未被引用) 被误放
`dependencies`，electron-builder 原样复制进 asar；而它们只被 `src/` import 且 Vite 已完整
打进 dist（零 bare import）。把这 4 个前端库移到 `devDependencies`，生产依赖仅留 `adm-zip`
（主进程 11 处真实 require）。实测 **app.asar 23.8MB → 1.44MB（-94%）**，解包 27M → 1.6M，
node_modules 仅剩 adm-zip；瘦身产物冒烟验证 adm-zip / 崩溃分析器 / IPC 契约均可加载。
`tests/asarSlim.test.cjs` 防回退。

**3. AI 可读崩溃日志摘要**
`engine/crash/aiDigest.cjs`（纯函数、零侵入）把 analyzer / guardian / logCleaner / ipcGuard
四路崩溃信息聚合成脱敏、有界、结构化的 Markdown + JSON；补齐了此前 `logCleaner` 读不到的
**JVM hs_err / JNI Segfault 原生帧**（`Problematic frame` / `C [libjvm.so+0x…]`），正好呼应
模块一C 的 JNI 防崩溃防线。全程脱敏 token/UUID/IP/邮箱，未识别特征如实留空、不臆造堆栈。
`tests/aiCrashDigest.test.cjs` 13 项覆盖。核心崩溃/JVM 模块补 JSDoc `@typedef` 类型注释，
新增 `docs/ARCHITECTURE.md` 模块解耦说明。

**4. E2E 真实官方源多源降级（不伪造）**
E2E-1 原本只拉被沙盒阻断的 `bmclapi2 /version/<id>/json` 端点导致 FAIL。改为引擎已有的真实
多源能力：失败后走 `launchermeta.mojang.com` 官方清单 → `piston-meta` 目标版本 json →
`libraries.minecraft.net` 依赖下载，报告写明实际数据源。**E2E 5/5 全绿**（E2E-4 NeoForge
因 `maven.neoforged.net` 被阻断，按既有设计标注「环境受限」，不谎报完整成功）。

## 测试与产物

| 项目 | 结果 |
| --- | --- |
| Node 全量测试 | **526 / 526**（含通宵新增 31 项专项测试） |
| Android Gradle JVM 单测 | **67 / 67** |
| 三端契约 | 102 invoke / 17 events / 10 native（零漂移） |
| 渲染层生产构建 | 83 modules |
| E2E 全链路 | **5 / 5**（官方源多源降级，环境受限 1 项明确标注） |
| app.asar | **1.44 MB**（较 v0.6.0 -94%） |
| 桌面产物 | `MC-Next-0.9.0.AppImage` / `MC-Next-0.9.0.tar.gz` |
| 安卓产物 | `MC-Next-Unified-0.9.0.apk`（release keystore 签名 + apksigner 验签） |
| 自动更新 | `latest.yml`（由真实产物字节生成 sha512 / size） |
| 源码 | `mc-next-source-0.9.0.tar.gz`（`git archive HEAD`） |

## 边界（延续不糊弄原则）

- 沙盒无 Windows Authenticode / Apple Developer ID 证书，不产出声称已签名的 `.exe` / `.dmg`；仓库提供可复现签名脚本 `tools/build-signed-desktop.sh`。Android 为真实自签名证书，非 Play 上架签名。
- 沙盒无真机：JNI 真 Segfault、游戏实际启动、`.so` 解压到 `nativeLibraryDir` 后的加载、24 小时真实 heap 曲线均无法实测；分别以受控 `crashSelfTest`、协议级 Mock、结构不变量高频等价验证替代，不谎称经历真机场景。`MCNEXT_LEGACY_PACKAGING=0` 可一键回退到 v0.6.0/v0.7.0 已验证的 STORED `.so` 链路。
- `.so` 压缩 trade-off 明示：APK 下载体积 -35.6%，安装后因解压会 +46.81 MiB（`nativeLibraryDir`），净安装占用略增。
- 真实浏览器 OAuth2 / Mojang profile / Modrinth 下载 / P2P 双节点握手受沙盒网络限制，沿用协议级 Mock 并明确标注，不伪造成功。
