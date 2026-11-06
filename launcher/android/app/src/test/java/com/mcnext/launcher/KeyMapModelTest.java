package com.mcnext.launcher;

import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;

/** KeyMapModel：死区、摇杆、手柄映射、布局序列化的纯逻辑真值测试 */
public class KeyMapModelTest {

    @Test public void 死区过滤与线性重映射() {
        assertEquals(0f, KeyMapModel.applyDeadzone(0.10f, 0.18f), 1e-6f);
        assertEquals(0f, KeyMapModel.applyDeadzone(0.18f, 0.18f), 1e-6f);
        // 0.59 在 deadzone=0.18 下应重映射为 (0.59-0.18)/0.82 = 0.5
        assertEquals(0.5f, KeyMapModel.applyDeadzone(0.59f, 0.18f), 1e-6f);
        assertEquals(-1f, KeyMapModel.applyDeadzone(-1f, 0.18f), 1e-6f);
        assertEquals(0f, KeyMapModel.applyDeadzone(0.05f, 10f), 1e-6f); // deadzone 上限钳制到 0.9
        assertEquals(1f, KeyMapModel.applyDeadzone(1f, -1f), 1e-6f);
    }

    @Test public void 摇杆方向位掩码() {
        assertEquals(0, KeyMapModel.axisMask(0.05f, 0.05f, 0.18f));
        assertEquals(KeyMapModel.MASK_FORWARD, KeyMapModel.axisMask(0f, -1f, 0.15f));
        assertEquals(KeyMapModel.MASK_BACK, KeyMapModel.axisMask(0f, 1f, 0.15f));
        assertEquals(KeyMapModel.MASK_LEFT, KeyMapModel.axisMask(-1f, 0f, 0.15f));
        assertEquals(KeyMapModel.MASK_RIGHT, KeyMapModel.axisMask(1f, 0f, 0.15f));
        int diag = KeyMapModel.axisMask(-1f, -1f, 0.15f);
        assertEquals(KeyMapModel.MASK_FORWARD | KeyMapModel.MASK_LEFT, diag);
    }

    @Test public void 位掩码转WASD键码() {
        assertArrayEquals(new int[]{KeyMapModel.KEY_W, KeyMapModel.KEY_D},
                KeyMapModel.maskToKeys(KeyMapModel.MASK_FORWARD | KeyMapModel.MASK_RIGHT));
        assertEquals(0, KeyMapModel.maskToKeys(0).length);
        assertEquals(4, KeyMapModel.maskToKeys(0xF).length);
    }

    @Test public void 手柄按钮映射为真实LWJGL键码() {
        assertEquals(KeyMapModel.KEY_SPACE, KeyMapModel.gamepadButton(KeyMapModel.GP_BUTTON_A));
        assertEquals(KeyMapModel.MOUSE_LEFT, KeyMapModel.gamepadButton(KeyMapModel.GP_BUTTON_X));
        assertEquals(KeyMapModel.MOUSE_RIGHT, KeyMapModel.gamepadButton(KeyMapModel.GP_BUTTON_Y));
        assertEquals(KeyMapModel.KEY_E, KeyMapModel.gamepadButton(KeyMapModel.GP_BUTTON_B));
        assertEquals(KeyMapModel.KEY_ESCAPE, KeyMapModel.gamepadButton(KeyMapModel.GP_BUTTON_START));
        assertEquals(KeyMapModel.KEY_D, KeyMapModel.gamepadButton(KeyMapModel.GP_DPAD_RIGHT));
        assertEquals(0, KeyMapModel.gamepadButton(9999));
    }

    @Test public void 扳机阈值触发攻击与使用() {
        assertEquals(0, KeyMapModel.triggerToMouse(0.1f, 0.1f, 0.5f));
        assertEquals(KeyMapModel.MOUSE_LEFT, KeyMapModel.triggerToMouse(0f, 0.9f, 0.5f));
        assertEquals(KeyMapModel.MOUSE_RIGHT, KeyMapModel.triggerToMouse(0.9f, 0f, 0.5f));
    }

    @Test public void 鼠标键码为负数且转换正确() {
        assertTrue(KeyMapModel.isMouse(KeyMapModel.MOUSE_LEFT));
        assertTrue(KeyMapModel.isMouse(KeyMapModel.MOUSE_MIDDLE));
        assertFalse(KeyMapModel.isMouse(KeyMapModel.KEY_W));
        assertEquals(0, -KeyMapModel.MOUSE_LEFT - 1);  // 左键 → button 0
        assertEquals(1, -KeyMapModel.MOUSE_RIGHT - 1); // 右键 → button 1
    }

    @Test public void 默认布局覆盖移动跳跃攻击与快捷栏() {
        Map<String, Integer> m = KeyMapModel.defaultLayout();
        assertEquals(Integer.valueOf(KeyMapModel.KEY_W), m.get("forward"));
        assertEquals(Integer.valueOf(KeyMapModel.KEY_SPACE), m.get("jump"));
        assertEquals(Integer.valueOf(KeyMapModel.MOUSE_LEFT), m.get("attack"));
        assertEquals(Integer.valueOf(KeyMapModel.MOUSE_RIGHT), m.get("use"));
        assertEquals(Integer.valueOf(KeyMapModel.KEY_1), m.get("hotbar1"));
        assertEquals(20, m.size());
    }

    @Test public void 布局JSON往返一致() {
        Map<String, Integer> src = KeyMapModel.defaultLayout();
        String json = KeyMapModel.layoutToJson(src);
        assertTrue(json.startsWith("{") && json.endsWith("}"));
        assertTrue(json.contains("\"jump\":57"));
        Map<String, Integer> back = KeyMapModel.layoutFromJson(json);
        assertEquals(src.size(), back.size());
        for (String k : src.keySet()) assertEquals(src.get(k), back.get(k));
    }

    @Test public void 非法JSON不抛异常且自定义值生效() {
        assertTrue(KeyMapModel.layoutFromJson(null).isEmpty());
        assertTrue(KeyMapModel.layoutFromJson("{}").isEmpty());
        Map<String, Integer> custom = KeyMapModel.layoutFromJson("{\"jump\":42,\"bad\":oops}");
        assertEquals(Integer.valueOf(42), custom.get("jump"));
        assertNull(custom.get("bad"));
    }

    @Test public void 键名可读() {
        assertEquals("空格", KeyMapModel.keyName(KeyMapModel.KEY_SPACE));
        assertEquals("左键", KeyMapModel.keyName(KeyMapModel.MOUSE_LEFT));
        assertEquals("KEY_999", KeyMapModel.keyName(999));
    }
}
