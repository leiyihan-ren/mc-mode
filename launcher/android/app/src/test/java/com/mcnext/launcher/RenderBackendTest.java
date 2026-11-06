package com.mcnext.launcher;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

/** RenderBackend：GL4ES / ANGLE / VirGL / Zink 四后端选择与环境变量真实性 */
public class RenderBackendTest {

    @Test public void 四种后端均可选择() {
        assertSame(RenderBackend.GL4ES, RenderBackend.select("gl4es"));
        assertSame(RenderBackend.ANGLE, RenderBackend.select("ANGLE"));
        assertSame(RenderBackend.VIRGL, RenderBackend.select(" virgl "));
        assertSame(RenderBackend.ZINK, RenderBackend.select("zink"));
        assertEquals(4, RenderBackend.ALL.length);
    }

    @Test public void 未知后端回退GL4ES() {
        assertSame(RenderBackend.GL4ES, RenderBackend.select("unknown"));
        assertSame(RenderBackend.GL4ES, RenderBackend.select(null));
    }

    @Test public void 每个后端生成LWJGL属性与环境变量() {
        for (RenderBackend b : RenderBackend.ALL) {
            List<String> p = b.jvmProperties();
            assertEquals(3, p.size());
            assertTrue(p.get(0).startsWith("-Dorg.lwjgl.opengl.libname=" + b.openglLib));
            assertTrue(p.contains("-Dmcnext.renderer=" + b.id));
            assertFalse(b.env.isEmpty());
            assertEquals(b.env.get("POJAV_RENDERER") != null, true);
        }
    }

    @Test public void ANGLE需要两个native库() {
        List<String> l = RenderBackend.ANGLE.nativeLibs();
        assertTrue(l.contains("EGL_angle"));
        assertTrue(l.contains("GLESv2_angle"));
        assertEquals("gl4es_114", RenderBackend.GL4ES.nativeLibs().get(0));
    }

    @Test public void 环境变量不可被外部篡改() {
        try {
            RenderBackend.GL4ES.env.put("POJAV_RENDERER", "hacked");
            fail("env 应为只读");
        } catch (UnsupportedOperationException expected) { }
        assertEquals("galimir", RenderBackend.GL4ES.env.get("POJAV_RENDERER"));
    }

    @Test public void Zink含Adreno兼容开关() {
        assertEquals("noconform", RenderBackend.ZINK.env.get("TU_DEBUG"));
        assertEquals("zink", RenderBackend.ZINK.env.get("MESA_LOADER_DRIVER_OVERRIDE"));
    }
}
