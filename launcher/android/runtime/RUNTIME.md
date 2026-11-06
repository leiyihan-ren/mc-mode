# MC-Next Android 原生运行时（真实来源与边界）

本工程**不是 WebView / Capacitor 套壳**。APK 内是真实可执行的 Java 运行时、
JNI 启动桥、OpenGL 转译层与原生触控层。本文件记录每个二进制的**真实来源**、
校验方式与无法回避的边界，不含任何占位或伪造文件。

## 1. 已内置的真实二进制

| 组件 | 来源 | 校验 |
|---|---|---|
| JRE 17 arm64（`libjvm.so` 等 33 个 `.so` + `lib/modules`/`conf`/`cacerts` 等 110 个数据文件） | PojavLauncherTeam/android-openjdk-build-multiarch `jre17-ec28559` → `jre17-arm64-20210825-release.tar.xz` | SHA-256 `c64583ac2e0ec8857e43456fa9adcf482c6a8e454a7133173bf15692d2478b8d` |
| GL4ES `libgl4es_114.so`（2.53 MB） | PojavLauncher `gladiolus` APK → `lib/arm64-v8a/` | 见 `runtime/MANIFEST.json` |
| LWJGL / OpenAL / freetype / OSMesa / Vulkan freedreno / pojavexec 等 18 个 natives | 同上 | 同上 |
| `libmcnext_jni.so` | 本工程 `app/src/main/jni/*.c`，由 NDK r27c + CMake 3.22.1 本地交叉编译 | 源码在仓库内，可复现 |

渲染库通过 HTTP Range 读取远程 APK 的 zip 中央目录**按需抽取**（`tools/fetch-runtime.py`），
不需要下载 154 MB 整包。JRE 与渲染库共 52 个 `.so` 全部平铺到 `jniLibs/arm64-v8a/`，
`useLegacyPackaging = true` + `extractNativeLibs = true` 保证安装后落在 `nativeLibraryDir`，
满足 Android 10+ 的 W^X 约束（不能从 app data 目录 `dlopen` 可执行 `.so`）。

## 2. 启动链路（真实 JNI，不是模拟）

```
MainActivity
  → RuntimeManager.prepare()          assets/runtime/** → filesDir/runtime（递归复制，增量）
  → RuntimeManager.jreAvailable()     nativeLibraryDir/libjvm.so 存在性硬校验，缺失即明确报错
  → loadConfig(launch.json)           桌面端「导出移动端启动配置」生成
  → ArgBuilder.buildVmOptions()       -Xmx/-cp/-Djava.home/-Djava.library.path/-Dorg.lwjgl.*
  → RenderBackend.select()            GL4ES/ANGLE/VirGL/Zink → JVM 属性 + 进程环境变量
  → JvmBridge.applyRenderEnv()        JNI setenv(POJAV_RENDERER, MESA_*, TU_DEBUG …)
  → JvmBridge.startJvm()              dlopen(libjvm.so) → JNI_CreateJavaVM
                                      → FindClass(mainClass) → CallStaticVoidMethod(main, argv)
  → JvmBridge.setSurface()            ANativeWindow_fromSurface 交给 GL 后端创建 EGL 窗口
  → TouchOverlay / GamepadHandler    多点触控 + 外接手柄 → JNI 环形缓冲 → JVM 侧 LWJGL 轮询
```

## 3. 一键重建

```bash
cd android
python3.11 -m pip install remotezip          # 远程 zip 按需抽取
bash tools/build-apk.sh                      # 拉运行时 → JVM 单测 → NDK 编译 → assembleDebug
```

产物：`/workspace/MC-Next-Native-0.2.0.apk`（本次实测 73,693,598 字节）。

## 4. 诚实边界（不粉饰）

1. **游戏本体不在 APK 内**：Minecraft 客户端 Jar、assets、libraries 受版权与体积限制，
   必须由用户在手机存储中自行准备，并通过桌面端导出的 `launch.json` 指定 `classpath`。
   缺少 `launch.json` 时 App 会明确报错，不会用假数据启动。
2. **渲染后端**：GL4ES / OSMesa / Vulkan freedreno 的 `.so` 已真实内置；
   ANGLE / VirGL / Zink 的后端选择、JVM 属性与环境变量代码已实现，
   但对应 `.so` 需另行放入 `jniLibs` 才生效——没有的后端会回退到 GL4ES，不会假装渲染成功。
3. **未在实体 Android 设备上运行验证**：沙箱只有 Linux + NDK 交叉编译器，无 Android 设备/模拟器。
   已验证的是：36 个 JVM 单元测试全绿、JNI/C 交叉编译通过、APK 内 `.so` 与 JRE 数据完整、
   dex 与 JNI 方法签名匹配。真机 GL 上下文创建与 MC 主线程调起仍需设备实测。
4. **微软正版 / Authlib 登录**是桌面端能力；移动端沿用 `launch.json` 中的 `accessToken`。
