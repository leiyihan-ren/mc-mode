package com.mcnext.launcher;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * LaunchConfigLoader — 从 externalFilesDir/launch.json 读取真实实例配置。
 * 与原生工程 MainActivity.loadConfig 语义一致，抽出来供大一统 UI 的 game:launch 复用。
 * 文件不存在时抛明确异常，**绝不用假数据启动 JVM**。
 */
public final class LaunchConfigLoader {
    private LaunchConfigLoader() {}

    public static File configFile(Context c) {
        File base = c.getExternalFilesDir(null);
        if (base == null) base = c.getFilesDir();
        return new File(base, "launch.json");
    }

    public static LaunchConfig load(Context c) throws Exception {
        LaunchConfig cfg = new LaunchConfig();
        File home = RuntimeManager.runtimeHome(c);
        cfg.javaHome = home.getAbsolutePath();
        cfg.libraryPath = RuntimeManager.nativeLibDir(c);

        File base = c.getExternalFilesDir(null);
        if (base == null) base = c.getFilesDir();
        cfg.gameDir = new File(base, "instances/default/.minecraft").getAbsolutePath();
        cfg.assetsDir = new File(base, "assets").getAbsolutePath();
        cfg.classpath = new File(base, "instances/default/classpath.txt").getAbsolutePath();

        File f = configFile(c);
        if (!f.exists()) {
            throw new IllegalStateException("缺少 launch.json（" + f.getAbsolutePath()
                    + "）：请在「设置 → 远程控制」配置 PC 后导出移动端启动配置，"
                    + "或手动放入含 mainClass / classpath 的实例配置；不会用假数据启动。");
        }
        JSONObject j = new JSONObject(readAll(new FileInputStream(f)));
        cfg.version = j.optString("version", cfg.version);
        cfg.mainClass = j.optString("mainClass", cfg.mainClass);
        cfg.classpath = j.optString("classpath", cfg.classpath);
        cfg.gameDir = j.optString("gameDir", cfg.gameDir);
        cfg.assetsDir = j.optString("assetsDir", cfg.assetsDir);
        cfg.assetIndex = j.optString("assetIndex", cfg.assetIndex);
        cfg.versionType = j.optString("versionType", cfg.versionType);
        cfg.username = j.optString("username", cfg.username);
        cfg.uuid = j.optString("uuid", cfg.uuid);
        cfg.accessToken = j.optString("accessToken", "");
        cfg.renderer = j.optString("renderer", "gl4es");
        cfg.width = j.optInt("width", cfg.width);
        cfg.height = j.optInt("height", cfg.height);
        cfg.maxMemoryMb = j.optInt("maxMemoryMb", cfg.maxMemoryMb);
        cfg.minMemoryMb = j.optInt("minMemoryMb", cfg.minMemoryMb);
        return cfg.validate();
    }

    static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
