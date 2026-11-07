package com.mcnext.launcher;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;

/**
 * RuntimeManager — JRE 移植环境与渲染后端的资产准备
 *
 * 真实 Android 约束（不绕过、不伪造）：
 *  - Android 10+ 禁止从 app data 目录 dlopen 可执行 .so（W^X），因此 JRE 的
 *    libjvm.so / libjli.so / libjava.so 等必须打包进 APK 的 lib/<abi>/ 目录，
 *    由系统安装到 nativeLibraryDir，native 层用绝对路径 dlopen。
 *  - JRE 的数据文件（modules / lib / conf / cacerts / classlist）放 assets/runtime，
 *    首次启动解压到 filesDir/runtime，并通过 -Djava.home 指向它。
 *  - GL4ES / ANGLE / VirGL / Zink 的 .so 同样走 jniLibs，环境变量由 RenderBackend 生成。
 */
public final class RuntimeManager {
    private RuntimeManager() {}

    public static String nativeLibDir(Context c) {
        return c.getApplicationInfo().nativeLibraryDir;
    }

    public static File runtimeHome(Context c) {
        return new File(c.getFilesDir(), "runtime");
    }

    /** JRE 核心库是否已随 APK 安装（没有就明确报错，绝不假装能启动） */
    public static boolean jreAvailable(Context c) {
        return new File(nativeLibDir(c), "libjvm.so").exists();
    }

    /** 渲染后端所需的进程环境变量（需由 native 侧 setenv 或启动脚本应用） */
    public static Map<String, String> rendererEnv(String renderer) {
        return RenderBackend.select(renderer).env;
    }

    /** 解压 assets/runtime/** 到 filesDir/runtime（增量：已存在且非空则跳过） */
    public static File prepare(Context c) throws IOException {
        File home = runtimeHome(c);
        File stamp = new File(home, ".prepared");
        AssetManager am = c.getAssets();
        String[] top;
        try { top = am.list("runtime"); } catch (IOException e) { top = new String[0]; }
        if (stamp.exists() && top != null && top.length > 0) return home;
        if (!home.exists() && !home.mkdirs()) throw new IOException("无法创建运行时目录: " + home);
        if (top != null) for (String entry : top) copyAsset(am, "runtime/" + entry, new File(home, entry));
        new FileOutputStream(stamp).close();
        return home;
    }

    private static void copyAsset(AssetManager am, String assetPath, File dest) throws IOException {
        String[] children;
        try { children = am.list(assetPath); } catch (IOException e) { children = new String[0]; }
        if (children != null && children.length > 0) {
            if (!dest.exists() && !dest.mkdirs()) throw new IOException("无法创建目录: " + dest);
            for (String child : children) copyAsset(am, assetPath + "/" + child, new File(dest, child));
            return;
        }
        try (InputStream in = am.open(assetPath); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
}
