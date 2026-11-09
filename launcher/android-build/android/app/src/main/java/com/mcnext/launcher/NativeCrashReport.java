package com.mcnext.launcher;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * NativeCrashReport — 0.9.0 模块一C：JNI 原生层崩溃 → 与桌面 CrashDialog 同构的报告。
 *
 * 纯 Java、零外部依赖（刻意不引入 org.json：android.jar 的 JSONObject 在 JVM 单测里
 * 受 unitTests.returnDefaultValues 影响不可靠，本类必须能直接跑 JUnit）。
 * 输入由 C 层 / Java 层构造，格式受控；极简标量读取，解析失败一律返回 null，绝不抛异常。
 *
 * 三类真实输入（不伪造任何数据）：
 *  1) BridgeNative.dispatch 返回的 {nativeCrash:true, signal, ...} —— 指令级同步崩溃，当场拦截
 *  2) 上次进程遗留的崩溃标记 {nativeCrash:true, ...} —— JVM 内部线程异步崩溃，下次启动上报
 *  3) invoke() catch 到的 Throwable（Error / UnsatisfiedLinkError 等 JNI 链接错误）
 */
public final class NativeCrashReport {
    private NativeCrashReport() {}

    /** 报告 POJO：字段与 guardian.cjs buildReport / 前端 CrashDialog 渲染字段对齐 */
    public static final class Report {
        public final String code;
        public final String title;
        public final String severity;
        public final String reason;
        public final String human;
        public final String source;
        public final String stream;
        public final int signal;
        public final List<String> suggestions;
        public final List<String> evidence;
        public final long at;

        Report(String code, String title, String severity, String reason, String human,
               String source, String stream, int signal, List<String> suggestions,
               List<String> evidence, long at) {
            this.code = code;
            this.title = title;
            this.severity = severity;
            this.reason = reason;
            this.human = human;
            this.source = source;
            this.stream = stream;
            this.signal = signal;
            this.suggestions = suggestions;
            this.evidence = evidence;
            this.at = at;
        }
    }

    /** Linux/arm64 常见致命信号名（与 C 层 signal_name 对齐） */
    public static String signalName(int sig) {
        switch (sig) {
            case 4:  return "SIGILL";
            case 6:  return "SIGABRT";
            case 7:  return "SIGBUS";
            case 8:  return "SIGFPE";
            case 11: return "SIGSEGV";
            default: return sig > 0 ? "SIGNAL_" + sig : "UNKNOWN";
        }
    }

    // ---------------- 极简 JSON 标量读取（不引第三方解析器） ----------------

    /** 读取字符串字段；处理转义引号/换行/反斜杠；缺失或损坏返回 null。 */
    private static String str(String json, String key) {
        if (json == null) return null;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return null;
        int c = json.indexOf(':', i);
        if (c < 0) return null;
        int q = json.indexOf('"', c + 1);
        if (q < 0) return null;
        int e = q + 1;
        while (e < json.length()) {
            char ch = json.charAt(e);
            if (ch == '\\') { e += 2; continue; }
            if (ch == '"') break;
            e++;
        }
        if (e >= json.length()) return null;
        return json.substring(q + 1, e)
                .replace("\\\"", "\"")
                .replace("\\n", "\n")
                .replace("\\\\", "\\");
    }

    /** 读取整数字段；缺失/非数字返回 def。 */
    private static int intVal(String json, String key, int def) {
        if (json == null) return def;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return def;
        int c = json.indexOf(':', i);
        if (c < 0) return def;
        int p = c + 1;
        while (p < json.length() && (json.charAt(p) == ' ' || json.charAt(p) == '\t')) p++;
        int s = p;
        if (p < json.length() && json.charAt(p) == '-') p++;
        while (p < json.length() && Character.isDigit(json.charAt(p))) p++;
        if (s == p) return def;
        try { return Integer.parseInt(json.substring(s, p)); }
        catch (NumberFormatException e) { return def; }
    }

    /** 读取布尔字段（只看 true）。 */
    private static boolean boolVal(String json, String key) {
        if (json == null) return false;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return false;
        int c = json.indexOf(':', i);
        if (c < 0) return false;
        return json.substring(c + 1).trim().startsWith("true");
    }

    private static boolean isFatal(String json) {
        return boolVal(json, "nativeCrash") || boolVal(json, "fatal");
    }

    private static Report build(String channel, int signal, String reason, boolean lastSession) {
        String title = lastSession
                ? "上次启动因底层原生层崩溃退出"
                : "底层 JNI / 原生通信崩溃（已安全拦截）";
        String source = lastSession ? "crash-marker" : "jni";
        List<String> suggestions = Arrays.asList(
                lastSession
                        ? "上次崩溃已记录，若反复出现请切换渲染后端或降低内存分配"
                        : "本次操作已被安全拦截，启动器不会闪退，可重试或切换版本",
                "尝试切换渲染后端（GL4ES / VirGL / Zink）",
                "检查 Java 版本与 natives 库是否匹配当前游戏版本",
                "若为模组导致，先禁用最近新增的原生模组后重试"
        );
        List<String> evidence = new ArrayList<>();
        evidence.add("channel=" + channel);
        evidence.add("signal=" + (signal > 0 ? signalName(signal) + "(" + signal + ")" : "unknown"));
        String human = title + "。\n命中：" + reason + "\n建议：" + suggestions.get(0);
        return new Report("NATIVE_CRASH", title, "fatal", reason, human, source, "jni",
                signal, suggestions, evidence, System.currentTimeMillis());
    }

    /** BridgeNative.dispatch 返回值 → 报告；非致命 / 非法 JSON 返回 null（不误报）。 */
    public static Report fromDispatch(String channel, String resultJson) {
        if (!isFatal(resultJson)) return null;
        int sig = intVal(resultJson, "signal", 0);
        String name = str(resultJson, "signalName");
        if (name == null) name = signalName(sig);
        String err = str(resultJson, "error");
        if (err == null) err = "JNI 原生层崩溃";
        return build(channel, sig, "[" + channel + "] " + name + " · " + err, false);
    }

    /** 上次进程遗留的崩溃标记 → 报告；空 / null / 非致命返回 null。 */
    public static Report fromMarker(String markerJson) {
        if (markerJson == null || markerJson.trim().isEmpty() || "null".equals(markerJson.trim())) return null;
        if (!isFatal(markerJson)) return null;
        int sig = intVal(markerJson, "signal", 0);
        String name = str(markerJson, "signalName");
        if (name == null) name = signalName(sig);
        String reason = "上次运行发生了 " + name + "（信号 " + sig
                + "），进程已终止；启动器据此补发崩溃提示";
        return build("last-session", sig, reason, true);
    }

    /** invoke() catch 到的 Throwable：只对 Error / JNI 原生特征上报，普通异常返回 null。 */
    public static Report fromThrowable(String channel, Throwable t) {
        if (t == null) return null;
        String text = t.getClass().getName() + ": " + String.valueOf(t.getMessage());
        String low = text.toLowerCase();
        boolean error = t instanceof Error;
        boolean nativeish = low.contains("unsatisfiedlinkerror") || low.contains("sigsegv")
                || low.contains("segfault") || low.contains("native") || low.contains("jni_")
                || low.contains("libjvm") || low.contains("gl4es");
        if (!error && !nativeish) return null;
        return build(channel, 0, "[" + channel + "] " + text, false);
    }
}
