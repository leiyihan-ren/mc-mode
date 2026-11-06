package com.mcnext.launcher;

import java.util.ArrayList;
import java.util.List;

/**
 * 启动配置 POJO —— 纯 Java，无 Android 依赖，可在 JVM 上直接单测。
 * 所有字段对应真实的 Minecraft JVM 启动参数。
 */
public final class LaunchConfig {
    public String javaHome = "";
    public String libraryPath = "";
    public String gameDir = "";
    public String assetsDir = "";
    public String resourcePackDir = "";
    public String version = "1.20.1";
    public String versionType = "release";
    public String assetIndex = "5";
    public String username = "Player";
    public String uuid = "00000000000000000000000000000000";
    public String accessToken = "";
    public String userType = "mojang";
    public String mainClass = "net.minecraft.client.main.Main";
    public String classpath = "";
    public int width = 1280;
    public int height = 720;
    public int maxMemoryMb = 2048;
    public int minMemoryMb = 512;
    public String renderer = "gl4es";
    public List<String> extraVmArgs = new ArrayList<>();
    public List<String> extraGameArgs = new ArrayList<>();

    public LaunchConfig() {}

    public LaunchConfig validate() {
        require(gameDir, "gameDir");
        require(assetsDir, "assetsDir");
        require(version, "version");
        require(mainClass, "mainClass");
        require(classpath, "classpath");
        if (maxMemoryMb < 128) throw new IllegalArgumentException("maxMemoryMb 过小");
        if (minMemoryMb > maxMemoryMb) throw new IllegalArgumentException("-Xms 不能大于 -Xmx");
        if (accessToken == null) accessToken = "";
        return this;
    }

    private static void require(String v, String name) {
        if (v == null || v.isEmpty()) throw new IllegalArgumentException("缺少必填启动参数: " + name);
    }
}
