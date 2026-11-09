package com.mcnext.launcher;

import android.content.Context;
import android.os.Build;

import java.util.Locale;

import javax.microedition.khronos.egl.EGL10;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.egl.EGLContext;
import javax.microedition.khronos.egl.EGLDisplay;
import javax.microedition.khronos.egl.EGLSurface;
import javax.microedition.khronos.opengles.GL10;

/**
 * GpuProbe — 0.7.0 模块三：真实读取 Android GPU 信息，供渲染后端自动选择 / 降级。
 *
 * 主路径：创建临时 1x1 EGL pbuffer 上下文查询 GL_RENDERER / GL_VENDOR（不依赖 SurfaceView）；
 * EGL 不可用（无 GL 上下文、模拟器、单测）时回退 Build.HARDWARE 字符串；
 * 仍无法识别则 vendor=unknown → 自动选 GL4ES（兼容优先），绝不伪造 GPU 型号。
 *
 * from() 是纯函数，各厂商分类可在 JVM 单测里完整覆盖；detect() 只在真机调用。
 */
public final class GpuProbe {
    private GpuProbe() {}

    public static final class Info {
        public final String raw;
        /** adreno | mali | powervr | nvidia | intel | unknown */
        public final String vendor;
        public final boolean vulkan;

        Info(String raw, String vendor, boolean vulkan) {
            this.raw = raw == null ? "" : raw;
            this.vendor = vendor;
            this.vulkan = vulkan;
        }

        public String summary() {
            return vendor + (vulkan ? "/vulkan" : "/gles") + " [" + raw + "]";
        }
    }

    /** 纯函数：从 GL_RENDERER / GL_VENDOR / 硬件描述串分类 GPU 厂商 */
    public static Info from(String renderer, String vendorHint, boolean vulkanCapable) {
        String s = ((renderer == null ? "" : renderer) + " "
                + (vendorHint == null ? "" : vendorHint)).toLowerCase(Locale.US);
        String v;
        if (s.contains("adreno")) v = "adreno";
        else if (s.contains("mali")) v = "mali";
        else if (s.contains("powervr") || s.contains("imagination")) v = "powervr";
        else if (s.contains("nvidia") || s.contains("tegra")) v = "nvidia";
        else if (s.contains("intel")) v = "intel";
        else v = "unknown";
        return new Info(s.trim(), v, vulkanCapable);
    }

    /** 真机探测；任何一步失败都降级为 unknown，不抛异常阻断启动 */
    public static Info detect(Context ctx) {
        boolean vulkan = false;
        try {
            vulkan = ctx.getPackageManager().hasSystemFeature("android.hardware.vulkan.version");
        } catch (Throwable ignored) { /* 单测 / 无 PackageManager */ }

        String gl = "";
        try { gl = queryGlStrings(); } catch (Throwable ignored) { /* EGL stub / 无 GL 上下文 */ }
        if (gl == null || gl.trim().isEmpty()) {
            gl = Build.HARDWARE + " " + Build.BOARD + " " + Build.MANUFACTURER;
        }
        return from(gl, Build.MANUFACTURER, vulkan);
    }

    private static String queryGlStrings() {
        EGL10 egl = (EGL10) EGLContext.getEGL();
        if (egl == null) return "";
        EGLDisplay dpy = egl.eglGetDisplay(EGL10.EGL_DEFAULT_DISPLAY);
        if (dpy == null || dpy == EGL10.EGL_NO_DISPLAY) return "";
        int[] ver = new int[2];
        if (!egl.eglInitialize(dpy, ver)) return "";

        EGLSurface surf = EGL10.EGL_NO_SURFACE;
        EGLContext ectx = EGL10.EGL_NO_CONTEXT;
        String out = "";
        try {
            int[] attr = { EGL10.EGL_SURFACE_TYPE, EGL10.EGL_PBUFFER_BIT, EGL10.EGL_NONE };
            EGLConfig[] cfgs = new EGLConfig[1];
            int[] n = new int[1];
            if (!egl.eglChooseConfig(dpy, attr, cfgs, 1, n) || n[0] == 0) return "";
            int[] pb = { EGL10.EGL_WIDTH, 1, EGL10.EGL_HEIGHT, 1, EGL10.EGL_NONE };
            surf = egl.eglCreatePbufferSurface(dpy, cfgs[0], pb);
            ectx = egl.eglCreateContext(dpy, cfgs[0], EGL10.EGL_NO_CONTEXT, null);
            if (surf == EGL10.EGL_NO_SURFACE || ectx == EGL10.EGL_NO_CONTEXT) return "";
            if (!egl.eglMakeCurrent(dpy, surf, surf, ectx)) return "";
            GL10 gl = (GL10) ectx.getGL();
            out = gl.glGetString(GL10.GL_RENDERER) + " " + gl.glGetString(GL10.GL_VENDOR);
        } finally {
            try {
                egl.eglMakeCurrent(dpy, EGL10.EGL_NO_SURFACE, EGL10.EGL_NO_SURFACE, EGL10.EGL_NO_CONTEXT);
                if (surf != EGL10.EGL_NO_SURFACE) egl.eglDestroySurface(dpy, surf);
                if (ectx != EGL10.EGL_NO_CONTEXT) egl.eglDestroyContext(dpy, ectx);
                egl.eglTerminate(dpy);
            } catch (Throwable ignored) { /* 清理失败不影响已取得的字符串 */ }
        }
        return out == null ? "" : out;
    }
}
