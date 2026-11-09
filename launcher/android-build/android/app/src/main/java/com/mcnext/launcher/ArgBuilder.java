package com.mcnext.launcher;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * ArgBuilder — 构造真实 Minecraft JVM 启动参数（纯 Java，可 JVM 单测）
 *
 * JVM 参数语义与桌面端 launcher.js / jvmArgs.js 对齐：
 *  - -Djava.library.path / -Dorg.lwjgl.librarypath 指向 JRE 与 GL4ES 等 native 目录
 *  - -Duser.dir / -Duser.home 指向实例 gameDir（版本隔离）
 *  - -cp 为完整 classpath，mainClass 之后是 --gameDir/--assetsDir/--accessToken 等游戏参数
 *
 * 0.7.0 模块三：追加移动端专用 GC 调度参数，减少后台 GC 线程唤醒、降低卡顿与发热。
 */
public final class ArgBuilder {
    private ArgBuilder() {}

    /**
     * 移动端 GC 调度基准参数。
     * Android 设备核心少、散热受限，默认 G1 的并发标记线程会持续唤醒 CPU；
     * SerialGC 把 GC 线程数降到 1，固定堆伸缩比减少 heap resize 抖动，
     * -XX:-UsePerfData 避免写 /tmp/hsperfdata 产生后台 IO。
     */
    public static List<String> mobileGcOptions() {
        return new ArrayList<>(Arrays.asList(
                "-XX:+UseSerialGC",
                "-XX:MinHeapFreeRatio=20",
                "-XX:MaxHeapFreeRatio=40",
                "-XX:-UsePerfData"
        ));
    }

    /** 用户已显式选择 GC 实现时不覆盖，只保留与实现无关的调优项 */
    public static List<String> mobileGcOptions(LaunchConfig c) {
        List<String> out = mobileGcOptions();
        List<String> extra = c == null ? null : c.extraVmArgs;
        boolean userPickedGc = false;
        if (extra != null) {
            for (String s : extra) {
                if (s != null && s.startsWith("-XX:+Use") && s.endsWith("GC")) {
                    userPickedGc = true;
                    break;
                }
            }
        }
        if (userPickedGc) out.remove("-XX:+UseSerialGC");
        return out;
    }

    public static List<String> buildVmOptions(LaunchConfig c) {
        c.validate();
        RenderBackend backend = RenderBackend.select(c.renderer);
        List<String> a = new ArrayList<>();
        a.add("-Xmx" + c.maxMemoryMb + "M");
        a.add("-Xms" + c.minMemoryMb + "M");
        a.add("-Djava.home=" + c.javaHome);
        a.add("-Duser.home=" + c.gameDir);
        a.add("-Duser.dir=" + c.gameDir);
        a.add("-Duser.timezone=Asia/Shanghai");
        a.add("-Dfile.encoding=UTF-8");
        a.add("-Djava.io.tmpdir=" + c.gameDir + "/tmp");
        a.add("-Djava.library.path=" + c.libraryPath);
        a.add("-Djna.boot.library.path=" + c.libraryPath);
        a.add("-Dorg.lwjgl.librarypath=" + c.libraryPath);
        a.add("-Dorg.lwjgl.glfw.checkThread0=false");
        a.add("-Dfml.ignoreInvalidMinecraftCertificates=true");
        a.add("-Dfml.ignorePatchDiscrepancies=true");
        a.add("-Dlog4j2.formatMsgNoLookups=true");
        for (String p : backend.jvmProperties()) a.add(p);
        a.addAll(mobileGcOptions(c));
        a.addAll(c.extraVmArgs);
        a.add("-cp");
        a.add(c.classpath);
        return a;
    }

    public static List<String> buildAppArgs(LaunchConfig c) {
        c.validate();
        List<String> a = new ArrayList<>();
        a.add("--gameDir");       a.add(c.gameDir);
        a.add("--assetsDir");     a.add(c.assetsDir);
        a.add("--resourcePackDir"); a.add(emptyTo(c.resourcePackDir, c.gameDir + "/resourcepacks"));
        a.add("--version");       a.add(c.version);
        a.add("--versionType");   a.add(c.versionType);
        a.add("--assetIndex");    a.add(c.assetIndex);
        a.add("--username");      a.add(c.username);
        a.add("--uuid");          a.add(c.uuid.replace("-", ""));
        a.add("--accessToken");   a.add(nullToEmpty(c.accessToken));
        a.add("--userType");      a.add(c.userType);
        a.add("--userProperties"); a.add("{}");
        a.add("--width");         a.add(String.valueOf(c.width));
        a.add("--height");        a.add(String.valueOf(c.height));
        a.addAll(c.extraGameArgs);
        return a;
    }

    /** 便于桌面/移动端共用的完整命令行（含 java 可执行文件路径） */
    public static List<String> buildCommandLine(String javaBinary, LaunchConfig c) {
        List<String> cmd = new ArrayList<>();
        cmd.add(javaBinary);
        cmd.addAll(buildVmOptions(c));
        cmd.add(c.mainClass);
        cmd.addAll(buildAppArgs(c));
        return cmd;
    }

    private static String emptyTo(String v, String fallback) { return v == null || v.isEmpty() ? fallback : v; }
    private static String nullToEmpty(String v) { return v == null ? "" : v; }
}
