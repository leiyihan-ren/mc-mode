package com.mcnext.launcher;

/**
 * BridgeNative — Capacitor UI → JNI 指令桥的 Java 边界。
 * 与 JvmBridge 共用 libmcnext_jni.so（CMake 把 bridge_commands.c 编进同一个库）。
 */
public final class BridgeNative {
    static { System.loadLibrary("mcnext_jni"); }

    private BridgeNative() {}

    /**
     * @param channel  C 层函数表里的底层指令名（probe.ping / jvm.status / input.key …）
     * @param argsJson 受控 JSON 参数
     * @return 可 JSON.parse 的结果字符串，永不返回 null
     */
    public static native String dispatch(String channel, String argsJson);
}
