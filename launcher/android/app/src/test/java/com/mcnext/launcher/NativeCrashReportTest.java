package com.mcnext.launcher;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * NativeCrashReportTest — 0.9.0 模块一C：JNI 崩溃报告纯 Java 单测。
 * 全部离线，无需 JNI / 真机 / 公网；沙盒内真实触发不了 Segfault，
 * 这里用协议级 JSON 字符串验证「崩溃 → 可弹窗报告」的解析与判定逻辑。
 */
public class NativeCrashReportTest {

    @Test
    public void signalNameMapsCommonFatalSignals() {
        assertEquals("信号 11", "SIGSEGV", NativeCrashReport.signalName(11));
        assertEquals("信号 7", "SIGBUS", NativeCrashReport.signalName(7));
        assertEquals("信号 6", "SIGABRT", NativeCrashReport.signalName(6));
        assertEquals("信号 8", "SIGFPE", NativeCrashReport.signalName(8));
        assertEquals("信号 4", "SIGILL", NativeCrashReport.signalName(4));
        assertEquals("未知信号", "SIGNAL_31", NativeCrashReport.signalName(31));
    }

    @Test
    public void fromDispatchNativeCrashProducesDialogPayload() {
        String json = "{\"ok\":false,\"nativeCrash\":true,\"fatal\":true,\"signal\":11,"
                + "\"signalName\":\"SIGSEGV\",\"code\":\"NATIVE_CRASH\","
                + "\"error\":\"JNI 指令执行中发生原生层崩溃(SIGSEGV)，已安全拦截\"}";
        NativeCrashReport.Report r = NativeCrashReport.fromDispatch("input.key", json);
        assertNotNull("nativeCrash 应产出报告", r);
        assertEquals("code", "NATIVE_CRASH", r.code);
        assertEquals("severity", "fatal", r.severity);
        assertEquals("source", "jni", r.source);
        assertEquals("stream", "jni", r.stream);
        assertEquals("signal", 11, r.signal);
        assertTrue("reason 应含 channel", r.reason.contains("input.key"));
        assertTrue("reason 应含 SIGSEGV", r.reason.contains("SIGSEGV"));
        assertTrue("human 应含建议", r.human.contains("建议"));
        assertFalse("suggestions 不应为空", r.suggestions.isEmpty());
        assertFalse("evidence 不应为空", r.evidence.isEmpty());
        assertTrue("at 应为正", r.at > 0);
    }

    @Test
    public void fromDispatchPlainErrorIsNotReported() {
        assertNull("普通业务失败不得弹崩溃窗",
                NativeCrashReport.fromDispatch("auth:remove", "{\"ok\":false,\"error\":\"账号不存在\"}"));
        assertNull("成功结果不得上报",
                NativeCrashReport.fromDispatch("probe.ping", "{\"ok\":true,\"pid\":1}"));
        assertNull("null 输入安全", NativeCrashReport.fromDispatch("x", null));
    }

    @Test
    public void fromDispatchMalformedJsonIsSafe() {
        assertNull("非法 JSON 不得抛异常",
                NativeCrashReport.fromDispatch("x", "{not json"));
        assertNull("空串安全", NativeCrashReport.fromDispatch("x", ""));
        // 缺 signalName 时应回退到信号名映射，不编造
        NativeCrashReport.Report r = NativeCrashReport.fromDispatch("x",
                "{\"nativeCrash\":true,\"signal\":11,\"error\":\"boom\"}");
        assertNotNull(r);
        assertTrue("缺失 signalName 应回退 SIGSEGV", r.reason.contains("SIGSEGV"));
    }

    @Test
    public void fromMarkerProducesLastSessionReport() {
        String marker = "{\"nativeCrash\":true,\"fatal\":true,\"signal\":11,"
                + "\"signalName\":\"SIGSEGV\",\"source\":\"jni-signal\"}";
        NativeCrashReport.Report r = NativeCrashReport.fromMarker(marker);
        assertNotNull("遗留标记应产出报告", r);
        assertTrue("标题应说明是上次会话", r.title.contains("上次"));
        assertEquals("source", "crash-marker", r.source);
        assertEquals("signal", 11, r.signal);
        assertTrue("reason 应含信号名", r.reason.contains("SIGSEGV"));
    }

    @Test
    public void fromMarkerNullOrPlainIsNull() {
        assertNull("null", NativeCrashReport.fromMarker(null));
        assertNull("空串", NativeCrashReport.fromMarker(""));
        assertNull("字符串 null", NativeCrashReport.fromMarker("null"));
        assertNull("非致命标记", NativeCrashReport.fromMarker("{\"ok\":true}"));
    }

    @Test
    public void fromThrowableOnlyReportsFatal() {
        assertNotNull("Error 应上报",
                NativeCrashReport.fromThrowable("game:launch", new OutOfMemoryError("Java heap space")));
        assertNotNull("UnsatisfiedLinkError 应上报",
                NativeCrashReport.fromThrowable("game:launch",
                        new UnsatisfiedLinkError("no lwjgl in java.library.path")));
        assertNull("普通 Exception 不上报",
                NativeCrashReport.fromThrowable("auth:remove", new IllegalStateException("账号不存在")));
        assertNull("null 安全", NativeCrashReport.fromThrowable("x", null));
    }

    @Test
    public void fromThrowableErrorCarriesChannelAndClassName() {
        NativeCrashReport.Report r = NativeCrashReport.fromThrowable("jvm.begin",
                new UnsatisfiedLinkError("libjvm.so not found"));
        assertNotNull(r);
        assertTrue("reason 应含 channel", r.reason.contains("jvm.begin"));
        assertTrue("reason 应含异常类名", r.reason.contains("UnsatisfiedLinkError"));
        assertEquals("source", "jni", r.source);
    }
}
