package com.mcnext.launcher;

import org.junit.Test;

import static org.junit.Assert.*;

/**
 * 【0.7.0 模块四】安卓端崩溃守护回归：
 *  实时拦截 OOM / 原生 Segfault / JVM boot / 缺库，防误杀、去重、异常退出兜底。
 * 纯 JVM 单测，不加载任何 .so，不依赖 Android API。
 */
public class CrashGuardTest {

    @Test
    public void strongOomReportedWithHumanReadableReport() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        AndroidCrashGuard.Report r = g.ingest(
                "Exception in thread \"Server thread\" java.lang.OutOfMemoryError: Java heap space");
        assertNotNull(r);
        assertEquals("OOM", r.code);
        assertEquals("fatal", r.severity);
        assertTrue(r.title.contains("堆内存溢出"));
        assertTrue(r.human.contains("堆内存溢出"));
        assertTrue(r.suggestions.size() > 0);
        assertTrue(r.suggestions.get(0).contains("Xmx"));
        assertFalse(r.ok());
    }

    @Test
    public void nativeCrashAndJvmBootAreStrong() {
        String[] lines = {
            "# A fatal error has been detected by the Java Runtime Environment:",
            "#  SIGSEGV (0xb) at pc=0x00007f, pid=12, tid=34",
            "Error: Could not find or load main class net.minecraft.client.main.Main",
            "java.lang.StackOverflowError",
            "java.lang.UnsatisfiedLinkError: no lwjgl in java.library.path"
        };
        String[] codes = {"NATIVE_CRASH", "NATIVE_CRASH", "JVM_BOOT", "STACK_OVERFLOW", "UNSATISFIED_LINK"};
        for (int i = 0; i < lines.length; i++) {
            AndroidCrashGuard g = new AndroidCrashGuard();
            AndroidCrashGuard.Report r = g.ingest(lines[i]);
            assertNotNull("应命中致命特征: " + lines[i], r);
            assertEquals(codes[i], r.code);
        }
    }

    @Test
    public void isolatedClassNotFoundIsNotAFalsePositive() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        AndroidCrashGuard.Report r = g.ingest(
                "[WARN] ClassNotFoundException caught while probing optional mod");
        assertNull("孤立 ClassNotFoundException 不得误报", r);
        assertEquals(0, g.reportedCount());
    }

    @Test
    public void contextAnchorConfirmsMissingLib() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        assertNull(g.ingest("java.lang.ClassNotFoundException: net.fabricmc.loader.launch"));
        AndroidCrashGuard.Report r = g.ingest("Exception in thread \"main\"");
        assertNotNull(r);
        assertEquals("MISSING_LIB", r.code);
        assertTrue(r.title.contains("缺少依赖库"));
    }

    @Test
    public void dedupePreventsDialogStorm() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        int n = 0;
        for (int i = 0; i < 20; i++) {
            if (g.ingest("java.lang.OutOfMemoryError: Java heap space #" + i) != null) n++;
        }
        assertEquals(1, n);
        assertEquals(1, g.reportedCount());
    }

    @Test
    public void normalLogsNeverTrigger() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        for (String l : new String[]{"[INFO] Preparing spawn area: 12%",
                "[INFO] Loaded 1024 recipes", "[WARN] Missing sound: step"}) {
            assertNull(g.ingest(l));
        }
        assertEquals(0, g.reportedCount());
    }

    @Test
    public void finishFallsBackForUnknownAbnormalExit() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        g.ingest("[INFO] Stopping server");
        AndroidCrashGuard.Report r = g.finish(1, null);
        assertNotNull(r);
        assertEquals("UNKNOWN_EXIT", r.code);
        assertEquals("exit", r.source);
        assertTrue(r.human.contains("异常退出"));
        assertTrue(g.isFinished());
    }

    @Test
    public void finishNoReportOnNormalExitIntentionalOrAlreadyReported() {
        AndroidCrashGuard a = new AndroidCrashGuard();
        assertNull("正常退出不弹窗", a.finish(0, null));

        AndroidCrashGuard b = new AndroidCrashGuard();
        b.markIntentional();
        assertNull("主动停止不弹窗", b.finish(-9, "SIGTERM"));

        AndroidCrashGuard c = new AndroidCrashGuard();
        assertNotNull(c.ingest("java.lang.OutOfMemoryError"));
        assertNull("已上报不重复", c.finish(1, null));
    }

    @Test
    public void finishIsIdempotentAndIngestAfterFinishIgnored() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        assertNotNull(g.finish(1, null));
        assertNull(g.finish(1, null));
        assertNull(g.ingest("java.lang.OutOfMemoryError"));
    }

    @Test
    public void finishUsesLastErrToIdentifyStrongFeature() {
        AndroidCrashGuard g = new AndroidCrashGuard();
        AndroidCrashGuard.Report r = g.finish(134, "java.lang.OutOfMemoryError: Direct buffer memory");
        assertNotNull(r);
        assertEquals("OOM", r.code);
    }

    @Test
    public void ringKeepsBoundedEvidence() {
        AndroidCrashGuard g = new AndroidCrashGuard(5);
        for (int i = 0; i < 20; i++) g.ingest("[INFO] line " + i);
        assertTrue("证据环形缓冲必须有界", g.ring().size() <= 5);
    }

    @Test
    public void concurrentIngestIsSafe() throws Exception {
        final AndroidCrashGuard g = new AndroidCrashGuard();
        Thread t1 = new Thread(() -> {
            for (int i = 0; i < 200; i++) g.ingest("[INFO] logcat line " + i);
        });
        Thread t2 = new Thread(() -> {
            for (int i = 0; i < 200; i++) g.ingest("[INFO] jvm line " + i);
        });
        t1.start(); t2.start(); t1.join(); t2.join();
        assertEquals(0, g.reportedCount());
        assertTrue(g.ring().size() <= 30);
    }
}
