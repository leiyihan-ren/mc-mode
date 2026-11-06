package com.mcnext.launcher;

import org.junit.Test;
import java.util.Arrays;
import java.util.List;
import static org.junit.Assert.*;

/** ArgBuilder：验证生成的 JVM 参数与游戏参数与真实 MC 启动协议一致 */
public class ArgBuilderTest {

    private LaunchConfig cfg() {
        LaunchConfig c = new LaunchConfig();
        c.gameDir = "/mcnext/instances/1.20.1";
        c.assetsDir = "/mcnext/assets";
        c.javaHome = "/mcnext/runtime";
        c.libraryPath = "/native/lib64";
        c.classpath = "/mcnext/1.20.1.jar:/mcnext/libraries/a.jar";
        c.username = "Steve";
        c.uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
        c.accessToken = "eyJhbGciOi.test";
        c.maxMemoryMb = 3072;
        c.minMemoryMb = 1024;
        return c;
    }

    @Test public void VM参数包含内存库路径与渲染属性() {
        List<String> vm = ArgBuilder.buildVmOptions(cfg());
        assertTrue(vm.contains("-Xmx3072M"));
        assertTrue(vm.contains("-Xms1024M"));
        assertTrue(vm.contains("-Djava.home=/mcnext/runtime"));
        assertTrue(vm.contains("-Duser.dir=/mcnext/instances/1.20.1"));
        assertTrue(vm.contains("-Djava.library.path=/native/lib64"));
        assertTrue(vm.contains("-Dorg.lwjgl.librarypath=/native/lib64"));
        assertTrue(vm.contains("-Dorg.lwjgl.opengl.libname=libgl4es_114.so"));
        assertTrue(vm.contains("-Dorg.lwjgl.glfw.checkThread0=false"));
        assertTrue(vm.contains("-Dlog4j2.formatMsgNoLookups=true"));
        int cp = vm.indexOf("-cp");
        assertTrue(cp >= 0);
        assertEquals("/mcnext/1.20.1.jar:/mcnext/libraries/a.jar", vm.get(cp + 1));
    }

    @Test public void 渲染后端切换影响GL库名() {
        LaunchConfig c = cfg(); c.renderer = "angle";
        List<String> vm = ArgBuilder.buildVmOptions(c);
        assertTrue(vm.contains("-Dorg.lwjgl.opengl.libname=libGLESv2_angle.so"));
        assertTrue(vm.contains("-Dmcnext.renderer=angle"));
    }

    @Test public void 游戏参数顺序与真实MC协议一致() {
        List<String> a = ArgBuilder.buildAppArgs(cfg());
        assertEquals("--gameDir", a.get(0));
        assertEquals("/mcnext/instances/1.20.1", a.get(1));
        assertEquals("--assetsDir", a.get(2));
        assertEquals("/mcnext/assets", a.get(3));
        assertEquals("--resourcePackDir", a.get(4));
        assertEquals("/mcnext/instances/1.20.1/resourcepacks", a.get(5));
        assertEquals("1.20.1", a.get(a.indexOf("--version") + 1));
        assertEquals("Steve", a.get(a.indexOf("--username") + 1));
        // UUID 必须去掉横线（MC 协议要求 32 位无分隔符）
        assertEquals("069a79f444e94726a5befca90e38aaf5", a.get(a.indexOf("--uuid") + 1));
        assertEquals("eyJhbGciOi.test", a.get(a.indexOf("--accessToken") + 1));
        assertEquals("{}", a.get(a.indexOf("--userProperties") + 1));
        assertEquals("1280", a.get(a.indexOf("--width") + 1));
    }

    @Test public void null令牌不产生null字符串() {
        LaunchConfig c = cfg(); c.accessToken = null;
        List<String> a = ArgBuilder.buildAppArgs(c);
        assertEquals("", a.get(a.indexOf("--accessToken") + 1));
        for (String s : a) assertNotNull(s);
    }

    @Test public void 额外参数被透传且顺序在末尾() {
        LaunchConfig c = cfg();
        c.extraVmArgs = Arrays.asList("-XX:+UseZGC");
        c.extraGameArgs = Arrays.asList("--demo");
        List<String> vm = ArgBuilder.buildVmOptions(c);
        assertTrue(vm.contains("-XX:+UseZGC"));
        List<String> a = ArgBuilder.buildAppArgs(c);
        assertEquals("--demo", a.get(a.size() - 1));
    }

    @Test public void 完整命令行以java二进制开头并含mainClass() {
        List<String> cmd = ArgBuilder.buildCommandLine("/mcnext/runtime/bin/java", cfg());
        assertEquals("/mcnext/runtime/bin/java", cmd.get(0));
        int main = cmd.indexOf("net.minecraft.client.main.Main");
        assertTrue(main > 0);
        assertEquals("--gameDir", cmd.get(main + 1));
    }
}
