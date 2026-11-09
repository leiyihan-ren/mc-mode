package com.mcnext.launcher;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * AndroidCrashGuard — 0.7.0 模块四：安卓端 JVM / 原生层崩溃实时拦截。
 *
 * 与桌面 engine/crash/guardian.cjs 同源的致命特征（OOM / 缺库 / Java 版本 / JVM boot /
 * 原生 Segfault / JNI hs_err / StackOverflow / UnsatisfiedLink），但用纯 Java 实现，
 * 不依赖任何 Android API，可在 JVM 单测（StabilityTest）中完整验证。
 *
 * 使用方：
 *   - NativeCommandRouter.startLogcatPump() 逐行 ingest() JNI / JVM 日志
 *   - JVM 线程 finally 里 finish(exitCode, lastErr) 做异常退出兜底
 * 命中后返回一份「人类能看懂」的报告（Report），由 Router emit("game:crash", ...) 弹窗。
 *
 * 防误杀：孤立 ClassNotFoundException 需崩溃锚点确认（与桌面一致）。
 * 去重：同一 code 只报一次，避免弹窗风暴。
 */
public final class AndroidCrashGuard {

    public static final class Rule {
        public final String code;
        public final String title;
        public final Pattern[] patterns;
        public final boolean strong;   // 出现即接管
        public final List<String> suggestions;
        Rule(String code, String title, boolean strong, String[] regex, String[] suggestions) {
            this.code = code; this.title = title; this.strong = strong;
            this.patterns = new Pattern[regex.length];
            for (int i = 0; i < regex.length; i++)
                this.patterns[i] = Pattern.compile(regex[i], Pattern.CASE_INSENSITIVE);
            this.suggestions = Arrays.asList(suggestions);
        }
        boolean matches(String line) {
            for (Pattern p : patterns) if (p.matcher(line).find()) return true;
            return false;
        }
    }

    public static final List<Rule> RULES = Arrays.asList(
        new Rule("OOM", "Java 堆内存溢出 (OutOfMemoryError)", true,
            new String[]{"java\\.lang\\.OutOfMemoryError", "Java heap space",
                "Could not reserve enough space", "insufficient memory for the Java Runtime"},
            new String[]{"降低 -Xmx 分配（不超过设备可用内存的一半）", "关闭后台占内存的应用",
                "减少大型整合包模组数量", "确认使用 64 位 JRE"}),
        new Rule("JVM_BOOT", "JVM 启动失败", true,
            new String[]{"Could not find or load main class", "Invalid maximum heap size",
                "Unrecognized option", "Could not create the Java Virtual Machine",
                "Error occurred during initialization of VM"},
            new String[]{"检查 mainClass 与 classpath 是否完整", "核对 -Xmx/-Xms 写法",
                "移除当前 JRE 不支持的 -XX 参数"}),
        new Rule("NATIVE_CRASH", "JVM 原生层崩溃（Segfault / Native Crash）", true,
            new String[]{"A fatal error has been detected", "SIGSEGV", "EXCEPTION_ACCESS_VIOLATION",
                "Problematic frame:", "hs_err_pid", "fatal signal", "SIGBUS|SIGFPE|SIGILL"},
            new String[]{"切换渲染后端（GL4ES / VirGL / Zink / ANGLE）", "检查 GL4ES 与 GPU 驱动兼容性",
                "删除可疑的原生模组", "把 hs_err_pid 日志提供给开发者"}),
        new Rule("STACK_OVERFLOW", "栈溢出 (StackOverflowError)", true,
            new String[]{"java\\.lang\\.StackOverflowError"},
            new String[]{"检查模组递归调用或循环依赖", "移除最近新增的可疑模组"}),
        new Rule("UNSATISFIED_LINK", "原生库加载失败 (UnsatisfiedLinkError)", true,
            new String[]{"java\\.lang\\.UnsatisfiedLinkError", "no lwjgl.*java\\.library\\.path",
                "Can't find dependent libraries", "dlopen failed"},
            new String[]{"确认 libjvm.so / GL4ES / LWJGL  natives 已随 APK 打包", "核对 arm64-v8a 架构一致",
                "检查 libc / OpenGL 运行库"}),
        new Rule("JAVA_VERSION", "Java 版本不匹配", false,
            new String[]{"UnsupportedClassVersionError", "class file version \\d+",
                "compiled by a more recent version of the Java Runtime"},
            new String[]{"1.16.5 及以下用 Java 8", "1.17~1.20.4 用 Java 17", "1.20.5+ 用 Java 21"}),
        new Rule("MISSING_LIB", "缺少依赖库 / 类版本冲突", false,
            new String[]{"ClassNotFoundException", "NoClassDefFoundError", "NoSuchMethodError",
                "NoSuchFieldError", "IncompatibleClassChangeError"},
            new String[]{"删除该版本 libraries 后重新补齐依赖", "检查重复 / 冲突模组",
                "Fabric 需确保 asm / sponge-mixin 在 classpath"}),
        new Rule("GL_RENDER", "OpenGL / 渲染初始化失败", false,
            new String[]{"GLFW error", "Could not create (?:GL|OpenGL) context", "Pixel format not accelerated",
                "OpenGL is not supported", "no opengl"},
            new String[]{"切换渲染后端（GL4ES / VirGL / Zink）", "删除 options.txt 后重试",
                "关闭显卡 overlay 类应用"}),
        new Rule("MOD_CONFLICT", "模组冲突 / 加载失败", false,
            new String[]{"Duplicate mod id", "ModLoadingException", "ModResolutionException",
                "Mixin apply failed", "Found duplicate mods"},
            new String[]{"检查 mods 目录重复模组", "核对模组对应的 MC / 加载器版本"})
    );

    /** 崩溃锚点：出现这些说明确实进入异常流程，可确认上下文型规则 */
    private static final Pattern[] ANCHORS = {
        Pattern.compile("Exception in thread"), Pattern.compile("Caused by:"),
        Pattern.compile("---- Minecraft Crash Report ----"), Pattern.compile("\\bFATAL\\b"),
        Pattern.compile("Game crashed!"), Pattern.compile("Description: [A-Za-z]"),
        Pattern.compile("Mixin apply failed"), Pattern.compile("A fatal error"),
        Pattern.compile("Problematic frame:"),
        Pattern.compile("Failed to (?:create|initialize|load)")
    };
    private static final int CONTEXT_WINDOW = 3;

    public static final class Report {
        public final String code, title, reason, human, source, severity;
        public final int exitCode;
        public final List<String> suggestions, evidence;
        Report(String code, String title, String severity, String reason, String source,
               int exitCode, Rule rule, List<String> evidence) {
            this.code = code; this.title = title; this.severity = severity;
            this.reason = reason; this.source = source; this.exitCode = exitCode;
            this.suggestions = new ArrayList<>(rule.suggestions);
            this.evidence = new ArrayList<>(evidence);
            this.human = title + "。\n命中：" + reason
                + "\n建议：" + (rule.suggestions.isEmpty() ? "查看日志定位原因" : rule.suggestions.get(0));
        }
        public boolean ok() { return false; }
    }

    private final int windowSize;
    private final Deque<String> ring = new ArrayDeque<>();
    private final Set<String> reported = new LinkedHashSet<>();
    private final List<Pending> pending = new ArrayList<>();
    private long lineNo = 0;
    // 用 -1 而非 Long.MIN_VALUE：后者参与 `lineNo - anchorAt` 会 long 溢出成负数，
    // 被误判为「锚点在窗口内」，导致孤立 ClassNotFoundException 误报。
    private long anchorAt = -1;
    private boolean finished = false;
    private boolean intentional = false;

    private static final class Pending {
        final Rule rule; final String line; final long at;
        Pending(Rule r, String l, long a) { rule = r; line = l; at = a; }
    }

    public AndroidCrashGuard() { this(30); }
    public AndroidCrashGuard(int windowSize) { this.windowSize = Math.max(1, windowSize); }

    /** 用户主动停止游戏：finish 不再产生崩溃报告 */
    public void markIntentional() { this.intentional = true; }

    private static boolean isAnchor(String text) {
        for (Pattern p : ANCHORS) if (p.matcher(text).find()) return true;
        return false;
    }

    /** 逐行喂入日志（logcat / JNI / JVM stderr）。命中致命特征返回报告，否则 null。
     *  synchronized：logcat pump 线程与 JVM 线程会并发调用，避免 ring / reported 竞态。 */
    public synchronized Report ingest(String line) {
        if (finished || line == null || line.trim().isEmpty()) return null;
        final String text = line;
        lineNo++;
        ring.addLast(text);
        while (ring.size() > windowSize) ring.removeFirst();

        boolean anchor = isAnchor(text);
        if (anchor) anchorAt = lineNo;

        Rule hit = null;
        for (Rule r : RULES) if (r.matches(text)) { hit = r; break; }
        if (hit != null) {
            boolean anchored = anchorAt > 0 && lineNo - anchorAt <= CONTEXT_WINDOW;
            if (hit.strong || anchor || anchored)
                return report(hit, text, "stream", 0);
            pending.add(new Pending(hit, text, lineNo));
            if (pending.size() > 8) pending.remove(0);
            return null;
        }
        if (anchor && !pending.isEmpty()) {
            Pending p = pending.get(pending.size() - 1);
            if (lineNo - p.at <= CONTEXT_WINDOW) {
                pending.clear();
                return report(p.rule, p.line, "stream", 0);
            }
        }
        return null;
    }

    private Report report(Rule rule, String reason, String source, int exitCode) {
        if (!reported.add(rule.code)) return null;
        return new Report(rule.code, rule.title, "fatal", reason, source, exitCode,
            rule, new ArrayList<>(ring));
    }

    /** JVM 线程 finally 兜底：异常退出必须给报告，正常退出 / 主动停止 / 已上报不重复。 */
    public synchronized Report finish(int exitCode, String lastErr) {
        if (finished) return null;
        finished = true;
        if (intentional || exitCode == 0 || !reported.isEmpty()) return null;

        // 直接匹配 lastErr（不能再走 ingest：finished 已置位，ingest 会拒绝处理）。
        // 同时把 lastErr 加入证据缓冲，保证报告里能看到真实原因。
        if (lastErr != null && !lastErr.trim().isEmpty()) {
            ring.addLast(lastErr);
            while (ring.size() > windowSize) ring.removeFirst();
            for (Rule r : RULES) {
                if (r.matches(lastErr)) {
                    return report(r, lastErr, "exit", exitCode);
                }
            }
        }
        // 与桌面 UNKNOWN_EXIT 同源：未识别特征也给人类可读报告
        Rule rule = new Rule("UNKNOWN_EXIT", "游戏异常退出（退出码 " + exitCode + "）", true,
            new String[]{"$a"}, // 不会被匹配，仅借用 Rule 结构承载建议
            new String[]{"打开控制台查看完整日志", "在崩溃诊断页提交最新日志",
                "确认 Java 版本与游戏版本匹配", "切换到其它渲染后端重试"});
        return report(rule,
            "JVM 退出 code=" + exitCode + (lastErr == null ? "" : " / " + lastErr),
            "exit", exitCode);
    }

    public int reportedCount() { return reported.size(); }
    public boolean isFinished() { return finished; }
    public List<String> ring() { return new ArrayList<>(ring); }
}
