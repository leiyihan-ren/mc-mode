package com.mcnext.launcher.input;

import com.mcnext.launcher.KeyMapModel;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * InputBridge — Java 侧输入出口：所有触控/手柄事件经此写入 native 环形缓冲，供 JVM 内 LWJGL 轮询。
 *
 * 真机：sink == null，调用 ensureNative() 加载 libmcnext_jni.so 走 JNI。
 * JVM 单测 / 桌面模拟器：通过 setSink() 注入内存出口，无需 .so 即可验证输入映射逻辑。
 * 两条路径共用同一套键码语义，测试覆盖的即是真机执行的代码路径。
 *
 * 0.7.0 模块三：全局维护「当前按下的键」集合，提供 releaseAllHeld() 兜底。
 * Activity 切后台 / 失去焦点 / JVM 崩溃时，虚拟按键往往收不到 ACTION_UP，
 * 若不主动释放，游戏内会卡在「一直前进 / 一直跳跃」。
 */
public final class InputBridge {
    /** 可注入事件出口 */
    public interface Sink {
        void key(int keycode, int scancode, boolean pressed);
        void mouse(int button, boolean pressed, float x, float y);
        void motion(float dx, float dy);
    }

    private static volatile Sink sink = null;
    private static volatile boolean nativeReady = false;
    /** 全局按下状态（线程安全）：记录原始 code，鼠标按钮为负数，见 KeyMapModel */
    private static final Set<Integer> heldKeys = Collections.synchronizedSet(new HashSet<Integer>());

    private InputBridge() {}

    public static void setSink(Sink s) { sink = s; }
    public static Sink getSink() { return sink; }

    private static void ensureNative() {
        if (!nativeReady) {
            synchronized (InputBridge.class) {
                if (!nativeReady) {
                    System.loadLibrary("mcnext_jni");
                    nativeReady = true;
                }
            }
        }
    }

    public static native boolean nativeSendKey(int keycode, int scancode, boolean pressed);
    public static native void nativeSendMouse(int button, boolean pressed, float x, float y);
    public static native void nativeSendMotion(float dx, float dy);
    public static native void nativeSetSensitivity(float sensitivity);
    public static native int nativePoll(int[] out);
    public static native int nativePending();
    public static native void nativeReset();

    /** 统一发送键码 / 鼠标按钮（负数键码 = 鼠标） */
    public static void send(int code, boolean pressed) {
        if (code == 0) return;
        if (pressed) heldKeys.add(code); else heldKeys.remove(code);
        deliver(code, pressed, 0, 0);
    }

    public static void sendAt(int code, boolean pressed, float x, float y) {
        if (code == 0) return;
        if (pressed) heldKeys.add(code); else heldKeys.remove(code);
        deliver(code, pressed, x, y);
    }

    private static void deliver(int code, boolean pressed, float x, float y) {
        Sink s = sink;
        if (KeyMapModel.isMouse(code)) {
            int button = -code - 1;
            if (s != null) s.mouse(button, pressed, x, y);
            else { ensureNative(); nativeSendMouse(button, pressed, x, y); }
        } else {
            if (s != null) s.key(code, 0, pressed);
            else { ensureNative(); nativeSendKey(code, 0, pressed); }
        }
    }

    public static void sendMotion(float dx, float dy) {
        Sink s = sink;
        if (s != null) s.motion(dx, dy);
        else { ensureNative(); nativeSendMotion(dx, dy); }
    }

    /** 当前仍被记录为按下的键数量（供诊断与单测） */
    public static int heldCount() {
        synchronized (heldKeys) { return heldKeys.size(); }
    }

    /**
     * 强制释放所有仍按住的虚拟键 / 鼠标按钮，返回释放数量。
     * 幂等：多次调用不会重复发送抬起事件。切后台、失焦、崩溃、销毁时调用。
     */
    public static int releaseAllHeld() {
        List<Integer> snapshot;
        synchronized (heldKeys) {
            if (heldKeys.isEmpty()) return 0;
            snapshot = new ArrayList<>(heldKeys);
            heldKeys.clear();
        }
        for (Integer code : snapshot) {
            Sink s = sink;
            if (KeyMapModel.isMouse(code)) {
                int button = -code - 1;
                if (s != null) s.mouse(button, false, 0, 0);
                else { ensureNative(); nativeSendMouse(button, false, 0, 0); }
            } else {
                if (s != null) s.key(code, 0, false);
                else { ensureNative(); nativeSendKey(code, 0, false); }
            }
        }
        return snapshot.size();
    }

    /** 以下为 JVM 侧轮询 / 生命周期入口，统一走懒加载，避免类初始化时依赖 .so */
    public static void reset() {
        synchronized (heldKeys) { heldKeys.clear(); }
        if (sink != null) return;
        ensureNative();
        nativeReset();
    }

    public static int poll(int[] out) {
        if (sink != null) return 0;
        ensureNative();
        return nativePoll(out);
    }

    public static int pending() {
        if (sink != null) return 0;
        ensureNative();
        return nativePending();
    }

    public static void setSensitivity(float v) {
        if (sink != null) return;
        ensureNative();
        nativeSetSensitivity(v);
    }
}
