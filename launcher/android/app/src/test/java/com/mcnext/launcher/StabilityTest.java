package com.mcnext.launcher;

import com.mcnext.launcher.input.InputBridge;
import com.mcnext.launcher.input.VirtualKeyMapper;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

import static org.junit.Assert.*;

/**
 * 【0.7.0 模块三】安卓底层适配回归：
 *  GPU 自动选择 / 渲染后端降级链 / 移动端 GC 调度 / 虚拟按键强制释放。
 * 纯 JVM 单测，注入 InputBridge.Sink，不加载任何 .so。
 */
public class StabilityTest {

    static final class Rec implements InputBridge.Sink {
        final List<String> ev = new ArrayList<>();
        @Override public void key(int k, int s, boolean p) { ev.add("K:" + k + ":" + p); }
        @Override public void mouse(int b, boolean p, float x, float y) { ev.add("M:" + b + ":" + p); }
        @Override public void motion(float dx, float dy) { ev.add("D"); }
    }

    private Rec rec;

    @Before public void setUp() {
        rec = new Rec();
        InputBridge.setSink(rec);
        InputBridge.releaseAllHeld();
        rec.ev.clear();
    }

    @After public void tearDown() {
        InputBridge.releaseAllHeld();
        InputBridge.setSink(null);
    }

    // ---------------- GPU 探测 ----------------
    @Test public void GPU厂商分类真实可靠() {
        assertEquals("adreno", GpuProbe.from("Adreno (TM) 740", "Qualcomm", true).vendor);
        assertEquals("mali", GpuProbe.from("Mali-G710", "ARM", true).vendor);
        assertEquals("powervr", GpuProbe.from("PowerVR Rogue", "Imagination", false).vendor);
        assertEquals("nvidia", GpuProbe.from("NVIDIA Tegra X1", "NVIDIA", true).vendor);
        assertEquals("intel", GpuProbe.from("Intel HD Graphics", "Intel", true).vendor);
        assertEquals("unknown", GpuProbe.from("qcom sm8250", "unknown", false).vendor);
        assertTrue(GpuProbe.from("Adreno 640", "Q", true).vulkan);
        assertFalse(GpuProbe.from("Adreno 505", "Q", false).vulkan);
        assertNotNull(GpuProbe.from("Adreno 740", "Q", true).summary());
    }

    // ---------------- 渲染后端自动 / 手动 / 降级 ----------------
    @Test public void 自动选择按GPU芯片分档() {
        assertSame(RenderBackend.ZINK, RenderBackend.autoSelect(GpuProbe.from("Adreno 740", "Q", true)));
        assertSame(RenderBackend.ANGLE, RenderBackend.autoSelect(GpuProbe.from("Adreno 505", "Q", false)));
        assertSame(RenderBackend.VIRGL, RenderBackend.autoSelect(GpuProbe.from("Mali-G77", "ARM", true)));
        assertSame(RenderBackend.GL4ES, RenderBackend.autoSelect(GpuProbe.from("Mali-400", "ARM", false)));
        assertSame(RenderBackend.GL4ES, RenderBackend.autoSelect(GpuProbe.from("PowerVR", "IMG", true)));
        assertSame(RenderBackend.GL4ES, RenderBackend.autoSelect(GpuProbe.from("unknown", "", false)));
        assertSame(RenderBackend.GL4ES, RenderBackend.autoSelect(null));
    }

    @Test public void resolve支持自动与手动且手动优先() {
        GpuProbe.Info gpu = GpuProbe.from("Adreno 740", "Qualcomm", true);
        assertSame(RenderBackend.ZINK, RenderBackend.resolve("auto", gpu));
        assertSame(RenderBackend.ZINK, RenderBackend.resolve(" AUTO ", gpu));
        assertSame(RenderBackend.ZINK, RenderBackend.resolve(null, gpu));
        assertSame("手动指定应覆盖自动结果", RenderBackend.GL4ES, RenderBackend.resolve("gl4es", gpu));
        assertSame(RenderBackend.VIRGL, RenderBackend.resolve("virgl", gpu));
        assertSame(RenderBackend.GL4ES, RenderBackend.resolve("bogus", gpu));
    }

    @Test public void 降级链以GL4ES保底且无重复() {
        List<RenderBackend> c = RenderBackend.fallbackChain(GpuProbe.from("Adreno 740", "Q", true));
        assertSame(RenderBackend.ZINK, c.get(0));
        assertSame(RenderBackend.GL4ES, c.get(c.size() - 1));
        assertEquals("候选不得重复", c.size(), new HashSet<>(c).size());
        assertEquals(4, c.size());
        List<RenderBackend> safe = RenderBackend.fallbackChain(GpuProbe.from("unknown", "", false));
        assertEquals("未知 GPU 应直接 GL4ES 保底，不做无谓重试", 1, safe.size());
        assertSame(RenderBackend.GL4ES, safe.get(0));
    }

    @Test public void fallback逐级降级到终点() {
        assertSame(RenderBackend.VIRGL, RenderBackend.fallback(RenderBackend.ZINK));
        assertSame(RenderBackend.ANGLE, RenderBackend.fallback(RenderBackend.VIRGL));
        assertSame(RenderBackend.GL4ES, RenderBackend.fallback(RenderBackend.ANGLE));
        assertNull(RenderBackend.fallback(RenderBackend.GL4ES));
        assertNull(RenderBackend.fallback(null));
    }

    @Test public void 原有select语义不变() {
        assertSame(RenderBackend.GL4ES, RenderBackend.select(null));
        assertSame(RenderBackend.GL4ES, RenderBackend.select("unknown"));
        assertSame(RenderBackend.ANGLE, RenderBackend.select("ANGLE"));
        assertEquals(4, RenderBackend.ALL.length);
    }

    // ---------------- 移动端 GC 调度 ----------------
    @Test public void 移动端GC参数减少后台线程与IO() {
        List<String> o = ArgBuilder.mobileGcOptions();
        assertTrue(o.contains("-XX:+UseSerialGC"));
        assertTrue(o.contains("-XX:MinHeapFreeRatio=20"));
        assertTrue(o.contains("-XX:MaxHeapFreeRatio=40"));
        assertTrue(o.contains("-XX:-UsePerfData"));
    }

    @Test public void buildVmOptions含移动端GC且用户自选GC不被覆盖() {
        LaunchConfig c = cfg();
        List<String> vm = ArgBuilder.buildVmOptions(c);
        assertTrue(vm.contains("-XX:+UseSerialGC"));
        assertTrue(vm.indexOf("-XX:+UseSerialGC") < vm.indexOf("-cp"));

        c.extraVmArgs = Arrays.asList("-XX:+UseZGC");
        List<String> vm2 = ArgBuilder.buildVmOptions(c);
        assertFalse("用户已选 ZGC 时不得再强制 SerialGC", vm2.contains("-XX:+UseSerialGC"));
        assertTrue(vm2.contains("-XX:+UseZGC"));
        assertTrue("与 GC 实现无关的调优仍应保留", vm2.contains("-XX:-UsePerfData"));
    }

    // ---------------- 触控映射稳定性 ----------------
    @Test public void 切后台强制释放所有按住的键且幂等() {
        VirtualKeyMapper m = new VirtualKeyMapper();
        m.onActionDown("forward", 1, 0, 0);
        m.onActionDown("jump", 2, 0, 0);
        m.onActionDown("sneak", 3, 0, 0);
        assertEquals(3, InputBridge.heldCount());

        rec.ev.clear();
        int n = InputBridge.releaseAllHeld();
        assertEquals(3, n);
        assertEquals(0, InputBridge.heldCount());
        assertEquals(3, rec.ev.size());
        for (String e : rec.ev) assertTrue("必须是抬起事件: " + e, e.endsWith(":false"));

        assertEquals("重复调用应幂等", 0, InputBridge.releaseAllHeld());
        assertEquals("不得重复发送抬起事件", 3, rec.ev.size());
    }

    @Test public void mapperReleaseAll后再兜底不产生重复抬起() {
        VirtualKeyMapper m = new VirtualKeyMapper();
        m.onActionDown("sneak", 1, 0, 0);
        m.releaseAll();
        int before = rec.ev.size();
        assertEquals(0, InputBridge.releaseAllHeld());
        assertEquals(before, rec.ev.size());
        assertEquals(0, InputBridge.heldCount());
    }

    @Test public void 鼠标按钮同样被兜底释放() {
        VirtualKeyMapper m = new VirtualKeyMapper();
        m.onActionDown("attack", 5, 10, 10);
        assertTrue(InputBridge.heldCount() > 0);
        rec.ev.clear();
        assertEquals(1, InputBridge.releaseAllHeld());
        assertTrue(rec.ev.contains("M:0:false"));
    }

    private LaunchConfig cfg() {
        LaunchConfig c = new LaunchConfig();
        c.gameDir = "/mcnext/instances/1.20.1";
        c.assetsDir = "/mcnext/assets";
        c.javaHome = "/mcnext/runtime";
        c.libraryPath = "/native/lib64";
        c.classpath = "/mcnext/1.20.1.jar";
        c.username = "Steve";
        c.uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
        c.maxMemoryMb = 3072;
        c.minMemoryMb = 1024;
        return c;
    }
}
