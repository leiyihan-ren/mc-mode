package com.mcnext.launcher;

import com.mcnext.launcher.input.InputBridge;
import com.mcnext.launcher.input.VirtualKeyMapper;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * VirtualKeyMapper 真实事件流测试：注入内存 Sink，验证多指、摇杆差量、松开与自定义布局。
 * 生产环境 sink == null，走同一份 send() → JNI 路径；此处仅替换出口，不改映射逻辑。
 */
public class VirtualKeyMapperTest {

    /** 收集 InputBridge 输出的事件出口 */
    static final class Recorder implements InputBridge.Sink {
        final List<String> events = new ArrayList<>();
        @Override public void key(int keycode, int scancode, boolean pressed) {
            events.add("K:" + keycode + ":" + pressed);
        }
        @Override public void mouse(int button, boolean pressed, float x, float y) {
            events.add("M:" + button + ":" + pressed);
        }
        @Override public void motion(float dx, float dy) {
            events.add("D:" + dx + ":" + dy);
        }
        long count(String prefix) { return events.stream().filter(e -> e.startsWith(prefix)).count(); }
        void clear() { events.clear(); }
    }

    private Recorder rec;
    private VirtualKeyMapper mapper;

    @Before public void setUp() {
        rec = new Recorder();
        InputBridge.setSink(rec);
        mapper = new VirtualKeyMapper();
    }

    @After public void tearDown() { InputBridge.setSink(null); }

    @Test public void 动作键按下与抬起成对() {
        mapper.onActionDown("jump", 1, 100f, 200f);
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_SPACE + ":true"));
        mapper.releasePointer(1);
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_SPACE + ":false"));
        assertEquals(2, rec.events.size());
    }

    @Test public void 鼠标攻击键走按钮0而不是键码() {
        mapper.onActionDown("attack", 7, 300f, 400f);
        assertTrue(rec.events.contains("M:0:true"));
        assertFalse(rec.events.toString().contains("K:-1"));
        mapper.releasePointer(7);
        assertTrue(rec.events.contains("M:0:false"));
    }

    @Test public void 多指互不串键且各自松开() {
        mapper.onActionDown("forward", 1, 10f, 10f);
        mapper.onActionDown("attack", 2, 200f, 200f);
        assertEquals(2, rec.events.size());
        mapper.releasePointer(1);
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_W + ":false"));
        // 第二指仍按住，不应产生鼠标抬起事件
        assertFalse(rec.events.contains("M:0:false"));
        assertEquals(3, rec.events.size());
        mapper.releasePointer(2);
        assertTrue(rec.events.contains("M:0:false"));
    }

    @Test public void 同一指针切换动作会先释放旧键() {
        mapper.onActionDown("forward", 1, 0f, 0f);
        mapper.onActionDown("jump", 1, 0f, 0f);
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_W + ":false"));
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_SPACE + ":true"));
    }

    @Test public void 摇杆差量更新只发送变化边沿() {
        mapper.updateJoystick(0f, -1f);            // 前
        assertEquals(KeyMapModel.MASK_FORWARD, mapper.currentJoystickMask());
        assertEquals(1, rec.count("K:"));
        assertEquals("K:" + KeyMapModel.KEY_W + ":true", rec.events.get(0));

        rec.clear();
        mapper.updateJoystick(0f, -1f);            // 保持前：不应再发任何事件
        assertEquals(0, rec.events.size());

        mapper.updateJoystick(1f, -1f);            // 前+右：只新增 D
        assertEquals(1, rec.events.size());
        assertEquals("K:" + KeyMapModel.KEY_D + ":true", rec.events.get(0));

        rec.clear();
        mapper.updateJoystick(0f, 0f);             // 回中：W、D 都抬起
        assertEquals(2, rec.events.size());
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_W + ":false"));
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_D + ":false"));
        assertEquals(0, mapper.currentJoystickMask());
    }

    @Test public void releaseAll释放所有按住的键() {
        mapper.onActionDown("sneak", 1, 0f, 0f);
        mapper.updateJoystick(-1f, 0f);
        rec.clear();
        mapper.releaseAll();
        assertEquals(2, rec.events.size());
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_LSHIFT + ":false"));
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_A + ":false"));
        assertEquals(0, mapper.currentJoystickMask());
    }

    @Test public void 自定义布局生效且非法空布局被忽略() {
        Map<String, Integer> custom = new HashMap<>();
        custom.put("jump", KeyMapModel.KEY_F5);
        mapper.setLayout(custom);
        mapper.onActionDown("jump", 1, 0f, 0f);
        assertTrue(rec.events.contains("K:" + KeyMapModel.KEY_F5 + ":true"));
        mapper.setLayout(new HashMap<String, Integer>());
        assertEquals(KeyMapModel.KEY_F5, (int) mapper.getLayout().get("jump"));
    }

    @Test public void 拖动产生相对鼠标位移事件() {
        mapper.onActionDown("attack", 1, 0f, 0f);
        mapper.onActionMove(1, 12f, -4f);
        assertTrue(rec.events.contains("D:12.0:-4.0"));
        mapper.onActionMove(1, 0f, 0f);   // 微小抖动被过滤
        assertEquals(1, rec.count("D:"));
    }

    @Test public void 死区设置边界钳制() {
        mapper.setDeadzone(0.35f);
        assertEquals(0.35f, mapper.getDeadzone(), 1e-6f);
        mapper.setDeadzone(5f);
        assertEquals(0.35f, mapper.getDeadzone(), 1e-6f);
        mapper.setDeadzone(-1f);
        assertEquals(0.35f, mapper.getDeadzone(), 1e-6f);
        // 提高死区后，中等幅度摇杆不再触发
        mapper.setDeadzone(0.8f);
        mapper.updateJoystick(0f, -0.5f);
        assertEquals(0, mapper.currentJoystickMask());
    }
}
