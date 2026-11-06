package com.mcnext.launcher;

import org.junit.Test;
import java.util.Arrays;
import static org.junit.Assert.*;

/** LaunchConfig 校验：真实 MC 启动参数的必填约束与内存合法性 */
public class LaunchConfigTest {

    private LaunchConfig valid() {
        LaunchConfig c = new LaunchConfig();
        c.gameDir = "/data/data/com.mcnext.launcher/files/instances/1.20.1";
        c.assetsDir = "/sdcard/MC-Next/assets";
        c.classpath = "/sdcard/MC-Next/versions/1.20.1/1.20.1.jar:/sdcard/libraries/*";
        c.javaHome = "/data/data/com.mcnext.launcher/files/runtime";
        c.libraryPath = "/data/app/~~mcnext/lib/arm64";
        return c;
    }

    @Test public void 合法配置通过校验() {
        LaunchConfig c = valid();
        assertSame(c, c.validate());
    }

    @Test public void 缺少必填参数逐个报错() {
        String[][] cases = {
            {"gameDir", "缺少必填启动参数: gameDir"},
            {"assetsDir", "缺少必填启动参数: assetsDir"},
            {"version", "缺少必填启动参数: version"},
            {"mainClass", "缺少必填启动参数: mainClass"},
            {"classpath", "缺少必填启动参数: classpath"}
        };
        for (String[] cs : cases) {
            LaunchConfig c = valid();
            switch (cs[0]) {
                case "gameDir": c.gameDir = ""; break;
                case "assetsDir": c.assetsDir = ""; break;
                case "version": c.version = ""; break;
                case "mainClass": c.mainClass = ""; break;
                case "classpath": c.classpath = null; break;
            }
            try { c.validate(); fail("应当拒绝 " + cs[0]); }
            catch (IllegalArgumentException e) { assertEquals(cs[1], e.getMessage()); }
        }
    }

    @Test public void 内存参数非法被拒绝() {
        LaunchConfig c = valid(); c.maxMemoryMb = 64;
        try { c.validate(); fail(); } catch (IllegalArgumentException e) { assertTrue(e.getMessage().contains("maxMemoryMb")); }
        LaunchConfig d = valid(); d.minMemoryMb = 4096; d.maxMemoryMb = 1024;
        try { d.validate(); fail(); } catch (IllegalArgumentException e) { assertTrue(e.getMessage().contains("-Xms")); }
    }

    @Test public void accessToken为null时归一化为空串() {
        LaunchConfig c = valid(); c.accessToken = null;
        assertSame(c, c.validate());
        assertEquals("", c.accessToken);
    }

    @Test public void 默认字段符合真实MC语义() {
        LaunchConfig c = new LaunchConfig();
        assertEquals("net.minecraft.client.main.Main", c.mainClass);
        assertEquals("1.20.1", c.version);
        assertEquals("mojang", c.userType);
        assertEquals(1280, c.width);
        assertEquals(2048, c.maxMemoryMb);
        c.extraVmArgs = Arrays.asList("-XX:+UseG1GC");
        assertEquals(1, c.extraVmArgs.size());
    }
}
