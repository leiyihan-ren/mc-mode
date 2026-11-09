package com.mcnext.launcher;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.mcnext.launcher.input.InputBridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collections;
import java.util.List;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * NativeCommandRouter — 0.6.0 大一统 UI 的指令路由核心。
 *
 * 输入：window.mcnext 的某个方法 → (channel, argsJson, pc)
 * 落点由 BridgeContract（与桌面 preload.cjs 同源）决定：
 *   native  → 本机真实能力：JvmBridge.launch（dlopen libjvm.so + JNI_CreateJavaVM + GL4ES setenv）、
 *             BridgeNative.dispatch（JNI 状态机 / 输入队列 / DestroyJavaVM）、文件与 Intent
 *   remote  → HttpURLConnection POST 到 PC 端 :25300/api/rpc，复用桌面**真实 IPC handler**
 *   unknown → 明确拒绝
 *
 * 原则：任何一步做不到就返回带原因的 {ok:false}，绝不伪造「已启动 / 已连接 / 已下载」。
 */
public final class NativeCommandRouter {

    public interface EventSink { void emit(String channel, String payloadJson); }
    public interface SurfaceProvider { void show(); void hide(); }

    private static final int PC_PORT = 25300;
    private final Context ctx;
    private final EventSink sink;
    private volatile SurfaceProvider surfaceProvider;
    private volatile Thread jvmThread;
    private volatile boolean running = false;
    /** 0.7.0 模块四：本次 JVM 会话的崩溃守护器（logcat 逐行拦截 + 退出兜底） */
    private volatile AndroidCrashGuard crashGuard;
    /** 0.9.0 模块一C：JNI 崩溃防线安装标记（只装一次） */
    private boolean crashGuardInstalled = false;
    /** 上次会话遗留的原生崩溃报告，等 WebView 就绪（首次 invoke）后再 flush，避免事件丢失 */
    private volatile NativeCrashReport.Report pendingCrashReport = null;

    public NativeCommandRouter(Context ctx, EventSink sink) {
        this.ctx = ctx.getApplicationContext();
        this.sink = sink;
    }

    public void setSurfaceProvider(SurfaceProvider p) { this.surfaceProvider = p; }

    /** @return 可直接 JSON.parse 的结果字符串（与桌面 IPC 返回值同构） */
    public String invoke(String channel, String argsJson, String pc) {
        // 0.9.0 模块一C：先把上次会话遗留的原生崩溃报告发给已就绪的 WebView
        flushPendingCrash();
        ensureCrashGuard();
        String result;
        try {
            JSONArray args = new JSONArray(argsJson == null || argsJson.isEmpty() ? "[]" : argsJson);
            String kind = BridgeContract.classify(channel);
            if ("native".equals(kind)) result = invokeNative(channel, args);
            else if ("remote".equals(kind)) result = invokeRemote(channel, args, pc);
            else result = err("未知指令 " + channel + "（不在 preload 契约白名单内）");
        } catch (Throwable t) {
            // 0.9.0 模块一C：覆盖 Error（含 UnsatisfiedLinkError / JNI 链接失败），不止 Exception
            emitCrashIfAny(NativeCrashReport.fromThrowable(channel, t));
            return err("指令 " + channel + " 执行失败: " + t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        // JNI dispatch 返回的结构化 nativeCrash 结果 → 弹窗，而不是静默失败 / 闪退
        emitCrashIfAny(NativeCrashReport.fromDispatch(channel, result));
        return result;
    }

    // ============================ native 落点 ============================
    private String invokeNative(String channel, JSONArray args) throws Exception {
        switch (channel) {
            case "game:launch":      return launchGame(args);
            case "game:stop":        return stopGame();
            case "game:status":      return gameStatus();
            case "java:scan":        return javaScan();
            case "app:release":      return appRelease();
            case "app:openExternal": return openExternal(args);
            case "mobile:export":    return exportLaunchConfig(args);
            case "net:guide":        return netGuide();
            case "update:check":     return updateCheck(args);
            case "update:download":  return updateDownload(args);
            default:                 return err("native 落点未实现: " + channel);
        }
    }

    /** 真实启动 JVM：JRE 校验 → 解压运行时 → 读 launch.json → GL4ES 环境 → JNI_CreateJavaVM */
    private String launchGame(JSONArray args) throws Exception {
        if (running) return err("游戏已在运行");
        if (!RuntimeManager.jreAvailable(ctx)) {
            return err("JRE 未就绪：nativeLibraryDir 中找不到 libjvm.so。"
                    + "请用 tools/build-unified-apk.sh 重新构建内置 JRE 的 APK；不会伪造运行结果。");
        }
        RuntimeManager.prepare(ctx);
        final LaunchConfig cfg = LaunchConfigLoader.load(ctx);

        // 桌面 UI 透传的启动参数（versionJson 等桌面专有字段忽略，只取真实可用的覆盖项）
        JSONObject o = args.length() > 0 ? args.optJSONObject(0) : null;
        if (o != null) {
            if (o.has("versionId")) cfg.version = o.optString("versionId", cfg.version);
            if (o.has("playerName")) cfg.username = o.optString("playerName", cfg.username);
            if (o.has("uuid")) cfg.uuid = o.optString("uuid", cfg.uuid);
            if (o.has("renderer")) cfg.renderer = o.optString("renderer", cfg.renderer);
            if (o.has("maxMemoryMb")) cfg.maxMemoryMb = o.optInt("maxMemoryMb", cfg.maxMemoryMb);
        }

        // 0.7.0 模块三：按真实 GPU 自动挑选渲染后端；启动失败沿降级链继续尝试。
        // 手动：launch.json / 启动参数里显式写 gl4es|angle|virgl|zink，只跑指定后端。
        final GpuProbe.Info gpu = GpuProbe.detect(ctx);
        final boolean auto = cfg.renderer == null || cfg.renderer.trim().isEmpty()
                || "auto".equalsIgnoreCase(cfg.renderer.trim());
        final List<RenderBackend> chain = auto
                ? RenderBackend.fallbackChain(gpu)
                : Collections.singletonList(RenderBackend.resolve(cfg.renderer, gpu));

        if (surfaceProvider != null) surfaceProvider.show();
        BridgeNative.dispatch("jvm.begin", "{}");
        running = true;
        // 0.7.0 模块四：本次会话崩溃守护器；logcat 与 JVM 线程共享，命中致命特征即弹窗。
        crashGuard = new AndroidCrashGuard();
        emit("game:log", "level", "info", "text",
                "[MC-Next] 启动 JVM | " + cfg.version + " | GPU " + gpu.summary()
                        + " | 后端 " + (auto ? "自动" : "手动") + " " + chain.size() + " 个候选"
                        + " | mainClass=" + cfg.mainClass);
        startLogcatPump();

        jvmThread = new Thread(() -> {
            int code = -900;
            try {
                for (int i = 0; i < chain.size(); i++) {
                    RenderBackend b = chain.get(i);
                    cfg.renderer = b.id;   // JvmBridge 环境变量与 ArgBuilder GL 库名共用同一后端
                    emit("game:log", "level", "info", "text",
                            "[MC-Next] 渲染后端 " + (i + 1) + "/" + chain.size() + ": "
                                    + b.displayName + " (" + b.id + ")");
                    try {
                        code = JvmBridge.launch(ctx, cfg);   // 真实 dlopen(libjvm.so) + JNI_CreateJavaVM
                    } catch (Throwable t) {
                        code = -901;
                        String el = "[MC-Next] JVM 启动异常: " + t;
                        emit("game:log", "level", "error", "text", el);
                        emitCrashIfAny(crashGuard.ingest(el));
                    }
                    if (code == 0) break;
                    // 启动失败 / JVM 中途崩溃：立刻释放所有虚拟按键，避免卡在「一直按下」
                    InputBridge.releaseAllHeld();
                    if (i + 1 < chain.size()) {
                        emit("game:log", "level", "warn", "text",
                                "[MC-Next] 后端 " + b.id + " 未成功(code=" + code
                                        + ")，自动降级到 " + chain.get(i + 1).displayName);
                    }
                }
            } catch (Throwable t) {
                String el = "[MC-Next] 渲染后端调度异常: " + t;
                emit("game:log", "level", "error", "text", el);
                emitCrashIfAny(crashGuard.ingest(el));
            } finally {
                InputBridge.releaseAllHeld();   // 正常退出同样归零，杜绝残留按下状态
                running = false;
                BridgeNative.dispatch("jvm.end", "{\"code\":" + code + "}");
                String lastErr = JvmBridge.lastError();
                // 0.7.0 模块四：异常退出兜底，绝不让 UI 静默停在「启动中」。
                // 自动降级链全部失败才算真崩溃；成功(code==0) 由 finish 内部判定不报。
                emitCrashIfAny(crashGuard.finish(code, lastErr));
                emit("game:exit", "code", code, "error", lastErr == null ? "" : lastErr);
                if (surfaceProvider != null) surfaceProvider.hide();
            }
        }, "mcnext-jvm");
        jvmThread.start();

        org.json.JSONArray chainJson = new org.json.JSONArray();
        for (RenderBackend b : chain) chainJson.put(b.id);
        return new JSONObject()
                .put("ok", true)
                .put("started", true)
                .put("version", cfg.version)
                .put("renderer", cfg.renderer)
                .put("rendererAuto", auto)
                .put("rendererChain", chainJson)
                .put("gpu", gpu.summary())
                .put("mainClass", cfg.mainClass)
                .put("platform", "android")
                .toString();
    }

    /** 把本进程 logcat 里 JNI 层真实日志转发到 WebView；读不到就明确告知，不编造游戏日志 */
    private void startLogcatPump() {
        new Thread(() -> {
            Process p = null;
            try {
                p = Runtime.getRuntime().exec(new String[]{
                        "logcat", "-v", "brief", "-s",
                        "mcnext-jni:I", "mcnext-bridge:I", "*:S"});
                BufferedReader r = new BufferedReader(
                        new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while (running && (line = r.readLine()) != null) {
                    emit("game:log", "level", "info", "text", line);
                    // 0.7.0 模块四：JNI / JVM 日志逐行喂入崩溃守护，命中致命特征立即弹窗。
                    AndroidCrashGuard g = crashGuard;
                    if (g != null) emitCrashIfAny(g.ingest(line));
                }
            } catch (Exception e) {
                emit("game:log", "level", "warn", "text",
                        "[MC-Next] 无法读取 logcat（Android 日志权限限制）："
                                + e.getMessage() + "；不会伪造游戏日志");
            } finally {
                if (p != null) p.destroy();
            }
        }, "mcnext-logcat").start();
    }

    private String stopGame() {
        // 用户主动停止：标记守护器，避免 TERM 退出被误判成崩溃弹窗。
        AndroidCrashGuard g = crashGuard;
        if (g != null) g.markIntentional();
        String r = BridgeNative.dispatch("jvm.requestStop", "{}");
        emit("game:log", "level", "info", "text", "[MC-Next] 已向 JNI 发送 DestroyJavaVM 请求");
        return r;
    }

    /** 与桌面 game:status 同构：返回 JSON boolean，细节通过 game:log 输出 */
    private String gameStatus() {
        boolean alive = jvmThread != null && jvmThread.isAlive() && running;
        return alive ? "true" : "false";
    }

    private String javaScan() throws Exception {
        File lib = new File(RuntimeManager.nativeLibDir(ctx), "libjvm.so");
        JSONArray list = new JSONArray();
        if (lib.exists()) {
            list.put(new JSONObject()
                    .put("path", lib.getAbsolutePath())
                    .put("major", 17)
                    .put("vendor", "Bundled Android JRE 17 (arm64)")
                    .put("size", lib.length())
                    .put("valid", true)
                    .put("source", "apk:jniLibs"));
        }
        return new JSONObject()
                .put("ok", true)
                .put("list", list)
                .put("available", RuntimeManager.jreAvailable(ctx))
                .put("platform", "android")
                .toString();
    }

    /** 读取构建时拷进 assets 的 config/release.json（与桌面同源，不硬编码版本号） */
    private String appRelease() throws Exception {
        JSONObject cfg;
        try (InputStream in = ctx.getAssets().open("release.json")) {
            cfg = new JSONObject(LaunchConfigLoader.readAll(in));
        }
        String base = cfg.optString("repo") + "/releases/download/" + cfg.optString("tag");
        JSONObject assets = cfg.optJSONObject("assets") != null
                ? cfg.optJSONObject("assets") : new JSONObject();
        String mirror = cfg.optString("mirror", "");
        JSONObject out = new JSONObject()
                .put("page", cfg.optString("repo") + "/releases/tag/" + cfg.optString("tag"))
                .put("repo", cfg.optString("repo"))
                .put("tag", cfg.optString("tag"))
                .put("appImage", base + "/" + assets.optString("appImage", ""))
                .put("tarGz", base + "/" + assets.optString("tarGz", ""))
                .put("apk", base + "/" + assets.optString("apk", ""))
                .put("source", base + "/" + assets.optString("source", ""))
                .put("mirrorPrefix", mirror)
                .put("mirrorAppImage", mirror + base + "/" + assets.optString("appImage", ""))
                .put("mirrorApk", mirror + base + "/" + assets.optString("apk", ""))
                .put("platform", "android");
        try {
            out.put("appVersion", ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).versionName);
        } catch (Exception ignored) { /* 版本号非关键 */ }
        return out.toString();
    }

    private String openExternal(JSONArray args) throws Exception {
        String url = args.optString(0, "");
        if (url.isEmpty()) return err("缺少 URL");
        if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("market://")) {
            return err("拒绝非 http(s)/market URL: " + url);
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        return new JSONObject().put("ok", true).toString();
    }

    /** 把桌面导出的实例配置真实写入 externalFilesDir/launch.json，供 game:launch 读取 */
    private String exportLaunchConfig(JSONArray args) throws Exception {
        Object a0 = args.length() > 0 ? args.opt(0) : null;
        JSONObject cfg = null;
        if (a0 instanceof JSONObject) cfg = (JSONObject) a0;
        else if (a0 instanceof String) cfg = new JSONObject((String) a0);
        if (cfg == null) return err("缺少启动配置对象（mobile:export 的 cfg）");
        if (!cfg.has("mainClass") || !cfg.has("classpath")) {
            return err("启动配置缺少 mainClass / classpath，JVM 无法启动");
        }
        File f = LaunchConfigLoader.configFile(ctx);
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        try (OutputStream out = new FileOutputStream(f, false)) {
            out.write(cfg.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        return new JSONObject().put("ok", true).put("path", f.getAbsolutePath())
                .put("bytes", f.length()).toString();
    }

    private String netGuide() throws Exception {
        JSONArray steps = new JSONArray();
        String[][] data = {
                {"放行本机防火墙的 UDP / TCP 11010", "EasyTier 默认使用 UDP 11010 打洞，防火墙拦截会直接导致握手失败"},
                {"检查路由器 / 光猫的 UDP 限制", "对称 NAT / UDP 禁用环境下需改用公网中继节点"},
                {"确认公共共享节点可达", "用 easytier-cli peer 读取真实节点列表，不要凭 UI 猜测"},
                {"（跨网/复杂 NAT）部署公网中继", "在具备公网 IP 的机器上运行 easytier-core --network-name ..."},
                {"核对网络名与网络密钥完全一致", "任一字符不一致都不会出现在同一虚拟子网"},
                {"确认双方 EasyTier 版本一致", "协议不兼容会导致 peer 列表为空"},
                {"检查 TUN 虚拟网卡设备", "Android / 沙盒无 /dev/net/tun 时应使用 --no-tun"},
                {"用 easytier-cli 读取真实状态", "以 CLI 输出的 peer / route 为准"}
        };
        for (String[] d : data) steps.put(new JSONObject().put("title", d[0]).put("detail", d[1]));
        return new JSONObject()
                .put("title", "真实网络配置向导 · EasyTier P2P 联机")
                .put("subtitle", "Android 端展示；联机核心运行在 PC 端，状态以 easytier-cli 真实输出为准")
                .put("steps", steps)
                .put("platform", "android")
                .toString();
    }

    // ==================== 模块五：Android 热更新检查（本地，不伪造下载） ====================
    private static String versionFromTag(String tag) {
        return tag != null && tag.startsWith("mc-next-v") ? tag.substring("mc-next-v".length()) : (tag == null ? "" : tag);
    }
    private static int parseIntSafe(String s) {
        try { return Integer.parseInt(s.replaceAll("[^0-9].*$", "")); } catch (Exception e) { return 0; }
    }
    private static int compareVersion(String a, String b) {
        String[] x = (a + ".0.0").split("\\.");
        String[] y = (b + ".0.0").split("\\.");
        for (int i = 0; i < 3; i++) {
            int xi = parseIntSafe(x.length > i ? x[i] : "0");
            int yi = parseIntSafe(y.length > i ? y[i] : "0");
            if (xi != yi) return xi > yi ? 1 : -1;
        }
        return 0;
    }

    /** 请求 GitHub Releases API 检查新版本；返回与桌面 update:check 同构的字段 */
    private String updateCheck(JSONArray args) throws Exception {
        JSONObject cfg;
        try (InputStream in = ctx.getAssets().open("release.json")) {
            cfg = new JSONObject(LaunchConfigLoader.readAll(in));
        }
        String current = versionFromTag(cfg.optString("tag", ""));
        String repo = cfg.optString("repo", "").replaceFirst("^https?://github\\.com/", "").replaceAll("/+$", "");
        String api = "https://api.github.com/repos/" + repo + "/releases/latest";
        HttpURLConnection c = (HttpURLConnection) new URL(api).openConnection();
        try {
            c.setRequestMethod("GET");
            c.setConnectTimeout(8000);
            c.setReadTimeout(12000);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            // 0.9.0：UA 版本从 release.json 的 tag 派生，与桌面端单一数据源一致，不再硬编码。
            c.setRequestProperty("User-Agent", "MC-Next-Updater/" + (current.isEmpty() ? "dev" : current));
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (code >= 400 || in == null) return err("GitHub 版本检查失败 HTTP " + code);
            JSONObject j = new JSONObject(LaunchConfigLoader.readAll(in));
            String tag = j.optString("tag_name", "");
            String latest = versionFromTag(tag);
            int cmp = compareVersion(latest, current);
            String page = j.optString("html_url", cfg.optString("repo") + "/releases/latest");
            String apkUrl = null;
            JSONArray assets = j.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.optJSONObject(i);
                    if (a != null && a.optString("name", "").endsWith(".apk")) {
                        apkUrl = a.optString("browser_download_url", null);
                        if (a.optString("name", "").contains("Native")) break;
                    }
                }
            }
            String mirror = cfg.optString("mirror", "");
            return new JSONObject()
                    .put("ok", true)
                    .put("updateAvailable", cmp > 0)
                    .put("compare", cmp)
                    .put("currentVersion", current)
                    .put("latestVersion", latest)
                    .put("tag", tag)
                    .put("page", page)
                    .put("releasePage", page)
                    .put("apkUrl", apkUrl == null ? JSONObject.NULL : apkUrl)
                    .put("mirrorApkUrl", apkUrl == null ? JSONObject.NULL : mirror + apkUrl)
                    .put("platform", "android")
                    .put("note", "Android 端仅做检查提示，不静默安装 APK（系统限制）")
                    .toString();
        } finally { c.disconnect(); }
    }

    /** Android 不静默安装 APK：打开真实 Release 下载页并明确告知 */
    private String updateDownload(JSONArray args) throws Exception {
        String url = "";
        Object a0 = args.length() > 0 ? args.opt(0) : null;
        if (a0 instanceof JSONObject) {
            JSONObject o = (JSONObject) a0;
            url = o.optString("mirrorApkUrl", o.optString("page", o.optString("url", "")));
        } else if (a0 instanceof String) {
            url = (String) a0;
        }
        if (url.isEmpty() || "null".equals(url)) {
            JSONObject cfg;
            try (InputStream in = ctx.getAssets().open("release.json")) {
                cfg = new JSONObject(LaunchConfigLoader.readAll(in));
            }
            url = cfg.optString("repo") + "/releases/tag/" + cfg.optString("tag");
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) return err("下载地址不合法: " + url);
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        return new JSONObject()
                .put("ok", true).put("opened", true).put("url", url)
                .put("note", "Android 不支持静默安装 APK，已打开 Release 下载页，请手动安装")
                .toString();
    }

    // ============================ remote 落点 ============================
    /** 转发到桌面端 :25300/api/rpc，返回桌面真实 IPC handler 的结果，原样透传不改写 */
    private String invokeRemote(String channel, JSONArray args, String pc) throws Exception {
        if (pc == null || pc.trim().isEmpty()) {
            return err("尚未配置电脑 IP（设置 → 远程控制）：" + channel
                    + " 需要桌面端 MC-Next 在线；Android 端不伪造结果");
        }
        String host = pc.trim().replaceAll("^https?://", "").replaceAll("/+$", "");
        if (host.contains("/")) return err("电脑地址格式不合法: " + pc);
        URL url = new URL("http://" + host + ":" + PC_PORT + "/api/rpc");
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(5000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] body = new JSONObject().put("channel", channel).put("args", args)
                    .toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) { out.write(body); }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = in == null ? "{}" : LaunchConfigLoader.readAll(in);
            JSONObject o = new JSONObject(resp);
            if (code >= 400 || !o.optBoolean("ok", false)) {
                return err("PC 端返回 HTTP " + code + ": " + o.optString("error", "远程调用失败"));
            }
            return o.getString("result");
        } finally {
            c.disconnect();
        }
    }

    // ============================ 工具 ============================

    /**
     * 0.9.0 模块一C：安装 JNI 崩溃防线并读取上次会话遗留的崩溃标记（只执行一次）。
     * 崩溃标记由 C 层 signal handler 用 async-signal-safe 调用落盘；这里在 App 启动、
     * WebView 就绪前读取，缓存到 pendingCrashReport，待首次 invoke 时 flush 弹窗。
     * 防线安装失败（如 so 未就绪）如实降级到既有 logcat 守护，不阻断启动。
     */
    private synchronized void ensureCrashGuard() {
        if (crashGuardInstalled) return;
        crashGuardInstalled = true;
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), "mcnext_native_crash.json");
            String args = new JSONObject().put("path", f.getAbsolutePath()).toString();
            String r = BridgeNative.dispatch("probe.crashGuard", args);
            Object lc = new JSONObject(r).opt("lastCrash");
            if (lc != null && lc != JSONObject.NULL) {
                NativeCrashReport.Report report = NativeCrashReport.fromMarker(lc.toString());
                if (report != null) pendingCrashReport = report;
            }
        } catch (Throwable ignored) { /* 如实降级，不阻断启动 */ }
    }

    /** 上次会话崩溃报告延迟到 WebView 就绪后发送，避免构造期事件无人订阅而丢失。 */
    private void flushPendingCrash() {
        NativeCrashReport.Report r = pendingCrashReport;
        if (r == null) return;
        pendingCrashReport = null;
        emitCrashIfAny(r);
    }

    /**
     * 0.9.0 模块一C：把 JNI 原生层崩溃报告转成与桌面 guardian.cjs 同构的
     * game:crash 载荷，供前端 CrashDialog 统一弹窗。null 表示无需上报。
     */
    private void emitCrashIfAny(NativeCrashReport.Report r) {
        if (r == null || sink == null) return;
        try {
            JSONArray suggestions = new JSONArray();
            for (String s : r.suggestions) suggestions.put(s);
            JSONArray evidence = new JSONArray();
            for (String e : r.evidence) evidence.put("[jni] " + e);
            JSONObject p = new JSONObject()
                    .put("ok", false)
                    .put("code", r.code)
                    .put("title", r.title)
                    .put("severity", r.severity)
                    .put("reason", r.reason)
                    .put("human", r.human)
                    .put("source", r.source)
                    .put("stream", r.stream)
                    .put("exitCode", JSONObject.NULL)
                    .put("suggestions", suggestions)
                    .put("evidence", evidence)
                    .put("at", r.at)
                    .put("platform", "android");
            if (r.signal > 0) p.put("signal", r.signal);
            else p.put("signal", JSONObject.NULL);
            emit("game:crash", p);
        } catch (Exception ignored) { /* 单条坏报告不打断流程 */ }
    }

    /**
     * 0.7.0 模块四：把 AndroidCrashGuard.Report 转成与桌面 guardian.cjs 同构的
     * game:crash 载荷，供前端 CrashDialog 统一弹窗。null 表示无需上报。
     */
    private void emitCrashIfAny(AndroidCrashGuard.Report r) {
        if (r == null || sink == null) return;
        try {
            JSONArray suggestions = new JSONArray();
            for (String s : r.suggestions) suggestions.put(s);
            JSONArray evidence = new JSONArray();
            for (String e : r.evidence) evidence.put("[stderr] " + e);
            JSONObject p = new JSONObject()
                    .put("ok", false)
                    .put("code", r.code)
                    .put("title", r.title)
                    .put("severity", r.severity)
                    .put("reason", r.reason)
                    .put("human", r.human)
                    .put("source", r.source)
                    .put("stream", "stderr")
                    .put("exitCode", r.exitCode)
                    .put("signal", JSONObject.NULL)
                    .put("suggestions", suggestions)
                    .put("evidence", evidence)
                    .put("at", System.currentTimeMillis())
                    .put("platform", "android");
            emit("game:crash", p);
        } catch (Exception ignored) { /* 单条坏报告不打断 JVM 退出流程 */ }
    }

    private void emit(String channel, JSONObject payload) {
        if (sink != null) sink.emit(channel, payload.toString());
    }

    /** org.json 的 put() 抛受检 JSONException，lambda 内不能用链式 put；统一在此消化 */
    private void emit(String channel, Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]);
        } catch (Exception ignored) { return; }
        emit(channel, o);
    }

    private static String err(String msg) {
        try { return new JSONObject().put("ok", false).put("error", msg).toString(); }
        catch (Exception e) { return "{\"ok\":false,\"error\":\"internal error\"}"; }
    }
}
