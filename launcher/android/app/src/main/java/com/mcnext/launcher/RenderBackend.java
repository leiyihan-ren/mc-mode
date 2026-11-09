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
 *
 * 0.7.0 模块三：新增按 GPU 自动选择、手动指定、以及启动失败时的自动降级链。
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

    /** 原有语义不变：未知 / null → GL4ES 兼容优先 */
    public static RenderBackend select(String id) {
        if (id == null) return GL4ES;
        for (RenderBackend b : ALL) if (b.id.equalsIgnoreCase(id.trim())) return b;
        return GL4ES;
    }

    /**
     * 按 GPU 芯片自动挑选后端（纯逻辑，可单测）。
     * 依据真实移植栈经验：Adreno 用 Zink 需 TU_DEBUG=noconform；Mali 对 VirGL 兼容性较好；
     * PowerVR / 未知芯片一律 GL4ES 保底，避免激进后端导致进不去游戏。
     */
    public static RenderBackend autoSelect(GpuProbe.Info gpu) {
        if (gpu == null) return GL4ES;
        switch (gpu.vendor) {
            case "adreno":
                return gpu.vulkan ? ZINK : ANGLE;
            case "mali":
                return gpu.vulkan ? VIRGL : GL4ES;
            case "nvidia":
            case "intel":
                return gpu.vulkan ? VIRGL : GL4ES;
            case "powervr":
            default:
                return GL4ES;
        }
    }

    /** 请求值解析：null / 空 / "auto" → 自动；其余 → 手动指定（未知值仍回退 GL4ES） */
    public static RenderBackend resolve(String requested, GpuProbe.Info gpu) {
        if (requested == null) return autoSelect(gpu);
        String r = requested.trim();
        if (r.isEmpty() || "auto".equalsIgnoreCase(r)) return autoSelect(gpu);
        return select(r);
    }

    /**
     * 自动降级链：首选在前、GL4ES 兜底、无重复。
     * 未知 GPU 首选已是 GL4ES，直接单元素返回，不做无谓的重试折腾。
     */
    public static List<RenderBackend> fallbackChain(GpuProbe.Info gpu) {
        List<RenderBackend> out = new ArrayList<>();
        RenderBackend first = autoSelect(gpu);
        out.add(first);
        if (first == GL4ES) return out;
        for (RenderBackend b : new RenderBackend[]{ ANGLE, VIRGL, ZINK, GL4ES }) {
            if (!out.contains(b)) out.add(b);
        }
        return out;
    }

    /** 单个后端的下一级；GL4ES 是终点，返回 null 表示无可再降 */
    public static RenderBackend fallback(RenderBackend current) {
        if (current == null || current == GL4ES) return null;
        RenderBackend[] order = { ZINK, VIRGL, ANGLE, GL4ES };
        for (int i = 0; i < order.length - 1; i++) {
            if (order[i] == current) return order[i + 1];
        }
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
