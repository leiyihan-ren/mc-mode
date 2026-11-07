package com.mcnext.launcher;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * RenderBackend — Android 端 OpenGL 渲染后端配置（纯 Java，可 JVM 单测）
 *
 * 真实移植栈环境变量对齐 PojavLauncher / Zalith Launcher：
 *  - GL4ES : libgl4es_114.so，OpenGL 1.1~2.1 → GLES 转译（兼容性最好）
 *  - ANGLE : libEGL_angle.so + libGLESv2_angle.so，基于 Vulkan 的 GLES 实现
 *  - VirGL  : virglrenderer + Mesa，服务端式 GPU 虚拟化
 *  - Zink   : Mesa Gallium 的 Vulkan 后端（TU_DEBUG=noconform 用于 Adreno）
 *
 * 这些 .so 由 runtime/ 资产包提供（真实来源见 runtime/RUNTIME.md），
 * 本类只负责选择后端、生成 JVM 属性与进程环境变量，不虚报已内置二进制。
 */
public final class RenderBackend {
    public final String id;
    public final String displayName;
    public final String openglLib;
    public final String glfwLib;
    public final Map<String, String> env;

    private RenderBackend(String id, String displayName, String openglLib, String glfwLib, Map<String, String> env) {
        this.id = id;
        this.displayName = displayName;
        this.openglLib = openglLib;
        this.glfwLib = glfwLib;
        this.env = Collections.unmodifiableMap(env);
    }

    private static Map<String, String> m(String... kv) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) map.put(kv[i], kv[i + 1]);
        return map;
    }

    public static final RenderBackend GL4ES = new RenderBackend(
            "gl4es", "GL4ES（兼容优先）", "libgl4es_114.so", "libglfw.so",
            m("POJAV_RENDERER", "galimir", "LIBGL_ES", "2", "LIBGL_MIPMAP", "3"));

    public static final RenderBackend ANGLE = new RenderBackend(
            "angle", "ANGLE / Vulkan", "libGLESv2_angle.so", "libglfw.so",
            m("POJAV_RENDERER", "angle", "ANGLE_DEFAULT_PLATFORM", "vulkan"));

    public static final RenderBackend VIRGL = new RenderBackend(
            "virgl", "VirGL（虚拟 GPU）", "libGLESv2_virgl.so", "libglfw.so",
            m("POJAV_RENDERER", "virgl", "VIRGL_GLES", "1", "MESA_LOADER_DRIVER_OVERRIDE", "zink"));

    public static final RenderBackend ZINK = new RenderBackend(
            "zink", "Zink / Mesa Vulkan", "libGLESv2_zink.so", "libglfw.so",
            m("POJAV_RENDERER", "zink", "MESA_LOADER_DRIVER_OVERRIDE", "zink", "TU_DEBUG", "noconform"));

    public static final RenderBackend[] ALL = { GL4ES, ANGLE, VIRGL, ZINK };

    public static RenderBackend select(String id) {
        if (id == null) return GL4ES;
        for (RenderBackend b : ALL) if (b.id.equalsIgnoreCase(id.trim())) return b;
        return GL4ES;
    }

    /** JVM -D 属性：告诉 LWJGL 加载哪个 GL 库 */
    public List<String> jvmProperties() {
        List<String> p = new ArrayList<>();
        p.add("-Dorg.lwjgl.opengl.libname=" + openglLib);
        p.add("-Dorg.lwjgl.glfw.libname=" + glfwLib);
        p.add("-Dmcnext.renderer=" + id);
        return p;
    }

    /** 需要 System.loadLibrary 的 native 库名（运行时资产提供） */
    public List<String> nativeLibs() {
        List<String> l = new ArrayList<>();
        if (id.equals("angle")) { l.add("EGL_angle"); l.add("GLESv2_angle"); }
        else l.add(openglLib.replaceAll("^lib|\\.so$", ""));
        return l;
    }
}
