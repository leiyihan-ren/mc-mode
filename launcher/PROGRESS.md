# PROGRESS.md — MC-Next 启动器全自动开发日志

> 项目目标：交付一款媲美 PCL2/HMCL 的现代化 Minecraft 启动器
> 技术栈：Electron + React + TailwindCSS + Node.js 引擎
> 模式：TDD + 红队自审 + 断点持久化

## 当前状态总览
- **阶段1（资源下载与上传）**: ✅ 100% 完成
  - 客户端 103 个 jar ✅ 已下载+校验+上传 mc-mode
  - 服务端 97 个 jar ✅ 已下载+校验(97/97 SHA1)+上传 mc-sever Release（97/97 资产核对无缺失，共 2.8GB，blob API 写超时后切换 Release Assets 流式通道解决）
  - 加载器 167 个 ✅ 已下载+校验+上传 mc-mode
- **阶段2（解析引擎）**: ✅ 完成（manifest/versionJson，version.json 三形态覆盖）
- **阶段3（依赖补全与合并）**: ✅ 完成（library 规则语义经真实数据修正、merge 合并引擎）
- **阶段4（JVM参数+一键启动）**: ✅ 完成（jvmArgs/launcher，含真实 Java 进程测试）
- **阶段5（服务端部署）**: ✅ 完成（全类型识别+部署+Fabric launcherMeta 依赖+installer 依赖预下载）
- **阶段6（UI/UX）**: ✅ 完成（暗黑电竞风、5 页面、无头冒烟 5/5）
- **阶段7（TDD清洗与打包）**: ✅ 完成（E2E 5/5；AppImage/tar.gz 重新打包含全部引擎修复）

## 测试总览（最终）
- 单元测试: **74/74 通过**（9 引擎模块 + mavenPathOf/loaderVersionOf 新增覆盖）
- E2E: **5/5 通过**（E2E-1 客户端依赖补全 / E2E-2 原版服务端全生命周期含命令注入 / E2E-3 Fabric 服务端全生命周期 / E2E-4 NeoForge installer 分层断言[流程层全绿,完整层环境受限] / E2E-5 多源降级与哈希一致性）
- UI 冒烟: 5/5（xvfb 无头，截图确认渲染）
- 详细红队找茬与修复记录：见 TEST-REPORT.md（10 项根因修复）

## 打包产物（release/）
- `MC-Next-0.1.0.AppImage`（216MB，Linux 免安装即运行）
- `mc-next-0.1.0.tar.gz`（205MB，解压即用）
- `linux-unpacked/`（解包目录）
- 注：electron-builder 需 github.com 下载 electron zip 与 appimage 工具，沙箱下经 npmmirror 镜像 + 手动缓存注入解决

## 关键设计决策（红队修正记录）
1. **rules 语义**：原实现默认 allow 错误 → 经真实 1.21.11 version.json 中 java-objc-bridge 仅 [{allow,osx}] 证实：rules 非空时默认 disallow，最后匹配生效
2. **version.json 位置**：原版 jar 内是游戏元数据(protocol_version)无 mainClass；NeoForge installer 内是启动器定义；旧版 Forge 在 install_profile.versionInfo
3. **Fabric 服务端**：fabric-loader jar 自带 FabricServerLauncher(Main-Class)，无需外部 server-launcher 制品
4. **natives 库**：新版通过 classifier+rules 表达，且同时进 classpath（对齐官方行为）
5. **上传通道**：github.com 阻断 → GitHub API + npmmirror electron 镜像
6. **installer 预下载**：沙箱阻断 maven.neoforged.net → deployInstallerServer 增加多源预下载（BMCLAPI /maven/ 镜像），installer 本地 checksum 命中跳过下载
7. **E2E-4 环境限制**：JarJarFileSystems-0.4.0.jar（net.neoforged 坐标，sha1 ef7e5716）仅存在于被阻断的 maven.neoforged.net，全网镜像（BMCLAPI/阿里云/腾讯/华为/Central/ForgeMaven/GitHub Packages）均无此坐标版本 → E2E-4 分层断言，流程层必须通过，完整层记录环境受限

## 未解决问题
- .exe 需 wine / .dmg 需 macOS → 产出 AppImage + 文档说明
- Microsoft 正版登录：离线模式已实现，MS 设备码流为框架级
- 18 个极老加载器(Forge 1.1-1.10/NeoForge 1.20.1旧线)三源均 404，用户已放弃

## 环境
- node v22.13.1 / npm 11.9.0 / Java 20 (Zulu) / electron 二进制(npmmirror 镜像) / 磁盘 248G
- root 运行 electron 需 --no-sandbox

## 时间线
- 2026-10-25 11:47 项目启动
- 2026-10-25 12:30 引擎层完工(71 测试)

## 最终交付物
- `release/MC-Next-0.1.0.AppImage` — Linux 安装包（免安装即运行）
- `release/mc-next-0.1.0.tar.gz` — Linux 归档包
- `/workspace/mc-launcher-src.tar.gz` — 完整源码（含 PROGRESS.md / TEST-REPORT.md / tests / fixtures）
- `PROGRESS.md` — 本开发日志
- `TEST-REPORT.md` — 深度测试报告（红队 10 项修复）

## 时间线
- 2026-10-25 11:47 项目启动
- 2026-10-25 12:30 引擎层完工（71 测试）
- 2026-10-25 15:30 UI 层完工 + 无头冒烟 5/5
- 2026-10-25 17:06 首次打包成功（AppImage/tar.gz）
- 2026-10-25 18:17 E2E 5/5 全绿（Fabric launcherMeta / installer 预下载 / 快照陷阱等红队修复）
- 2026-10-25 18:30 重新打包含全部修复 → 最终交付


## ✅ 项目 100% 交付确认（2026-10-31）
- 单元测试 74/74 ✅
- E2E 5/5 全绿 ✅
- UI 无头冒烟 5/5 ✅
- AppImage 实机启动冒烟 ✅（稳定运行无崩溃）
- 服务端 97/97 上传 mc-sever Release 并核对无缺失（2809.5 MB）✅
- 客户端 103 + 加载器 167 已入库 mc-mode ✅

## 📱 移动端特化改造（2026-10-31）
- **局域网串流启动**：PC 端新增 `electron/remoteControl.cjs`（端口 25300，原生 http，无新依赖），暴露 /api/status|clients|logs|launch|stop|command；手机端设置页配 IP → 首页"📡 局域网串流启动"→ 电脑跑游戏、手机当遥控器
- **Intent 唤起**：自定义 Capacitor 原生插件 `IntentPlugin.java`（IntentBridge），一键唤起 PojavLauncher/FCL 等，未安装自动跳应用商店
- **移动 UI**：底部 Tab 导航（MobileNav）、设置页远程控制区块、控制台远程日志轮询（2s）
- **回归**：桌面端 smoke 5/5 ✅（React 16933 字符 + IPC 103 客户端）；远程 API 端到端 ✅（status/clients/launch 校验/logs）
- **产物**：`MC-Next-Mobile-Remote.apk`（4.3 MB，Android 7.0+）

---

## 🌐 生态扩展模块 v0.3.0（2026-11-06）

> 在 0.2.0 全平台原生重构（Electron 桌面 + Android JRE/GL4ES 原生壳）之上平滑扩展五大生态模块。

### 新增模块
1. **Java 运行环境智能管家** `engine/java/manager.cjs`：MC 版本→Java 主版本映射、本机 JDK 扫描、精确/兼容匹配、缺失时 Adoptium API + 清华镜像 + gh-proxy 下载并 SHA-256 校验解压。接入 `launchGameCore` 自动分配（不强制联网）。
2. **一键联机大厅** `engine/net/room.cjs`：真实 EasyTier v2.6.4 二进制 + 邀请码 `MCET1.<b64>.<crc>` + `RoomManager` + 真实 CLI `node/peer` 输出解析（虚拟 IP/peers 不伪造）。
3. **本地世界管家** `engine/world/{nbt,manager}.cjs`：NBT 手写解析、真实游玩时长（stats）、一键备份/回滚（保留 5 份 + pre-restore 快照 + Zip-Slip 防护）。**AI 剧情功能按用户要求已彻底删除**（仅保留扫描/备份回滚）。
4. **3D 皮肤渲染** `src/components/SkinViewer.jsx` + `engine/skin/manager.cjs`：skinview3d 实时渲染、拖拽旋转/缩放、Authlib-Injector 协议获取、上传需显式 endpoint+token（诚实边界，不伪造成功）。
5. **UI 多端一致性**：`design/tokens.json` 单一视觉数据源 → `tools/gen-tokens.py` 生成 `src/theme.css` + Android `colors.xml`；Tailwind 改指 CSS 变量（含 `-rgb` 通道以支持透明度修饰符）；沉浸式夜间护眼模式 `data-theme="midnight"`。

### 集成
- IPC 新增 21 个 handler（`java:* / lan:* / world:* / skin:*`），preload 全量桥接，React 新增 4 页面（JavaManager/Lobby/WorldManager/Skin）。
- 全量单测 **173/173 通过**（含四大模块单测 + 真实 EasyTier CLI 夹具）。

### 构建与交付
- 桌面：`npm run build` → `release/MC-Next-0.3.0.AppImage`(108MB) + `release/MC-Next-0.3.0.tar.gz`(102MB)。
- 安卓原生：`android/tools/build-apk.sh` → `MC-Next-Native-0.3.0.apk`(73.7MB，54 个 .so，libjvm.so/libgl4es/libmcnext_jni.so 校验通过)。
- 源码：`tools/publish-source.py` 推送 213 文件 → `main/launcher/`（commit `d5125c0a`）。
- Release：`mc-next-v0.3.0`，4 个产物 + gh-proxy 镜像（Range 2KB 核验 206 可下载）。
- 报告：`/workspace/DELIVERY-0.3.0.md`。

### 边界（不糊弄）
- 联机双节点真实 P2P 握手需公网/TUN，沙箱 loopback 未成功，未伪造「已连接」。
- 皮肤上传需用户显式配置 endpoint+token（LittleSkin 无公开稳定上传 API）。
- 新功能 UI 聚焦桌面端；原生 APK 复用 0.2.0 JRE/GL4ES 启动链，两端共享 engine/ 源码。

---

## 🛠 全能管家 v0.4.0（2026-11-07）：生态扩展与真实环境适配

> 在 0.3.0 之上平滑扩展，从「能启动」进化到「全能管家」。

### 三大模块
1. **真实 P2P 联机容错** `engine/net/guide.cjs` + 重写 `LobbyPage.jsx`：握手失败（运行 >10s 无 peer）自动弹窗「请检查防火墙/路由器 UDP 限制」；8 步排查向导、4 组分平台命令、UDP/TCP 11010 端口说明、EasyTier 官方链接。诊断只依据 `RoomManager.status()` 真实字段，不伪造「已连接」。
2. **模组与资源包智能管家** `engine/mods/manager.cjs` + `ModsPage.jsx`：真实解析 jar 内 `fabric.mod.json` / `quilt.mod.json` / `mods.toml` / `neoforge.mods.toml` / `mcmod.info`；启用禁用真实 rename；缺失前置（Fabric API 等）标红 + 官方引导链接；光影/材质包一键导入（SHA-256 + Zip-Slip 防护）；Iris/Oculus/OptiFine 自动检测。
3. **下载引擎多源加速** `engine/{sources,http,downloader}.*`：`mirrorFirstCandidates` 令 **BMCLAPI 首选 / Mojang 官方备用**（保留旧 `mirrorCandidates` 契约）；`backoffDelay` 指数退避（250→500→1000，上限 8000，可注入 sleepFn/jitter）；`onRetry` → `download:retry` 前端实时展示重试/换源。

### 集成与移动端一致性
- IPC 新增 12 个 channel（共 75 个），preload 新增 11 个桥接；React 新增 ModsPage、重写 LobbyPage、DownloadPage 展示源策略；Sidebar / MobileNav（新增「模组」入口）/ App 注册导航。
- stubbed-Electron 端到端烟测：12/12 新 channel 注册 + 真实临时目录功能全通过。

### 测试 / 构建 / 交付
- 全量单测 **229 / 229 通过**（新增 download-accel 18 / mods 24 / net-guide 14）。
- 桌面 `npm run build` → `MC-Next-0.4.0.AppImage`(109MB) + `.tar.gz`(103MB)。
- Android 原生 APK `MC-Next-Native-0.4.0.apk`(71MB，54 个 .so，Gradle test+assemble 全绿)。
- **Capacitor APK 首次构建踩坑并修复**：`cap sync` 每次覆盖为 `JavaVersion.VERSION_21`，JDK 20 报 `invalid source release: 21`；固化 `android-build/tools/build-capacitor.sh`（sync→sed 降 17→gradlew），重建 `BUILD SUCCESSFUL` 且校验内嵌本轮 `index-CPyRHu1v.js`，已删除误复制的旧包。
- Release `mc-next-v0.4.0` 5 个产物 + gh-proxy 206 核验；源码 259 文件 → `main/launcher/`（commit `2be9e451`）；报告 `/workspace/DELIVERY-0.4.0.md`。

### 边界（延续不糊弄原则）
- 双节点真实 P2P 握手仍需公网/TUN/双设备环境人工验证，沙盒内未伪造成功。
- 模组冲突为静态元数据检测，非游戏内加载结果；Capacitor APK 是 WebView 壳，能跑 MC 的是原生 APK。
- AI「三国剧情」保持删除（按用户此前要求）；皮肤上传仍需显式 endpoint+token。

