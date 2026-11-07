package com.mcnext.launcher;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * McNextBridge — 0.6.0 大一统 UI 的唯一 Capacitor 插件。
 *
 * WebView 里 window.mcnext 的 84 个方法全部收敛为一个 invoke(channel, argsJson, pc)，
 * 由 NativeCommandRouter 按 BridgeContract 白名单派发：
 *   native → JNI / JvmBridge / GL4ES；remote → PC 端 /api/rpc 真实 IPC handler。
 * JVM 日志/退出通过 notifyListeners 推给 WebView（game:log / game:exit）。
 *
 * 线程：所有指令在后台线程执行，避免阻塞 WebView；game:launch 内部另起 JVM 线程。
 */
@CapacitorPlugin(name = "McNextBridge")
public class McNextBridgePlugin extends Plugin {

    private NativeCommandRouter router;

    @Override
    public void load() {
        router = new NativeCommandRouter(getContext(), (channel, payloadJson) -> {
            JSObject ev = new JSObject();
            ev.put("payload", payloadJson);
            notifyListeners(channel, ev);
        });
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).bindRouter(router);
        }
    }

    @PluginMethod
    public void invoke(PluginCall call) {
        final String channel = call.getString("channel");
        final String argsJson = call.getString("argsJson", "[]");
        final String pc = call.getString("pc", "");
        if (channel == null || channel.isEmpty()) {
            call.reject("缺少 channel");
            return;
        }
        if (!BridgeContract.isKnownInvoke(channel)) {
            call.reject("非法 channel（不在 preload 契约白名单内）: " + channel);
            return;
        }
        new Thread(() -> {
            String payload = router.invoke(channel, argsJson, pc);
            JSObject ret = new JSObject();
            ret.put("result", payload);
            call.resolve(ret);
        }, "mcnext-rpc").start();
    }

    /** 供设置页/诊断页读取桥接健康状态（真实 JNI 探针） */
    @PluginMethod
    public void probe(PluginCall call) {
        new Thread(() -> {
            JSObject ret = new JSObject();
            ret.put("result", BridgeNative.dispatch("probe.ping", "{}"));
            call.resolve(ret);
        }, "mcnext-probe").start();
    }
}
