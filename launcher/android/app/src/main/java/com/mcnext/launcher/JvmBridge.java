package com.mcnext.launcher;

import android.content.Context;
import android.view.Surface;

import java.util.List;
import java.util.Map;

/**
 * JvmBridge — Java ↔ JNI 边界。native 侧真实创建 JVM 并把启动参数透传进去。
 */
public final class JvmBridge {
    static { System.loadLibrary("mcnext_jni"); }

    private JvmBridge() {}

    /** @return 0 正常退出；负值见 jvm_launcher.c 的错误码 */
    public static native int startJvm(String[] vmOptions, String mainClass,
                                      String[] appArgs, String runtimeLibDir);

    /** 绑定/释放 ANativeWindow（GL4ES / ANGLE 创建 EGL 窗口用） */
    public static native void setSurface(Surface surface);
    public static native long getNativeWindowPtr();
    public static native String lastError();
    public static native int jvmStatus();
    public static native long uptimeMs();

    /** 把渲染后端所需的进程环境变量（POJAV_RENDERER / MESA_* / TU_DEBUG …）真正写入进程 */
    public static native void applyRenderEnv(String[] keyValues);

    public static int launch(Context ctx, LaunchConfig cfg) {
        String libDir = RuntimeManager.nativeLibDir(ctx);
        Map<String, String> env = RenderBackend.select(cfg.renderer).env;
        String[] kv = new String[env.size()];
        int i = 0;
        for (Map.Entry<String, String> e : env.entrySet()) kv[i++] = e.getKey() + "=" + e.getValue();
        applyRenderEnv(kv);
        List<String> vm = ArgBuilder.buildVmOptions(cfg);
        List<String> app = ArgBuilder.buildAppArgs(cfg);
        return startJvm(vm.toArray(new String[0]), cfg.mainClass,
                app.toArray(new String[0]), libDir);
    }
}
