package com.mcnext.launcher.input;

import com.mcnext.launcher.KeyMapModel;

import java.util.HashMap;
import java.util.Map;

/**
 * VirtualKeyMapper — 多点触控 → LWJGL 键码映射
 *
 * 真实要点：
 *  - 每个 pointerId 独立记录按下的虚拟键，多指同时操作不串键
 *  - 摇杆采用「差量更新」：只发送 mask 变化对应的 press/release，避免每帧刷爆事件队列
 *  - 右屏拖动作为鼠标相对位移，交给 JVM 侧 glfwSetCursorPos
 */
public final class VirtualKeyMapper {
    private static final float DEFAULT_DEADZONE = 0.18f;

    private Map<String, Integer> layout = KeyMapModel.defaultLayout();
    private final Map<Integer, Integer> pointerKeys = new HashMap<>();
    private final Map<Integer, Float> pointerX = new HashMap<>();
    private final Map<Integer, Float> pointerY = new HashMap<>();
    private int joystickMask = 0;
    private float deadzone = DEFAULT_DEADZONE;

    public void setLayout(Map<String, Integer> custom) {
        if (custom != null && !custom.isEmpty()) layout = custom;
    }
    public Map<String, Integer> getLayout() { return layout; }
    public void setDeadzone(float d) { if (d >= 0 && d < 0.9f) deadzone = d; }
    public float getDeadzone() { return deadzone; }

    private int keyFor(String action) {
        Integer k = layout.get(action);
        return k == null ? 0 : k;
    }

    public void onActionDown(String action, int pointerId, float x, float y) {
        int code = keyFor(action);
        if (code == 0) return;
        releasePointer(pointerId);
        pointerKeys.put(pointerId, code);
        pointerX.put(pointerId, x);
        pointerY.put(pointerId, y);
        InputBridge.sendAt(code, true, x, y);
    }

    public void onActionMove(int pointerId, float dx, float dy) {
        if (pointerKeys.containsKey(pointerId) && (Math.abs(dx) > 0.01f || Math.abs(dy) > 0.01f)) {
            InputBridge.sendMotion(dx, dy);
        }
    }

    public void releasePointer(int pointerId) {
        Integer code = pointerKeys.remove(pointerId);
        pointerX.remove(pointerId);
        pointerY.remove(pointerId);
        if (code != null) InputBridge.send(code, false);
    }

    /** 左摇杆：差量更新 WASD */
    public void updateJoystick(float rawX, float rawY) {
        int next = KeyMapModel.axisMask(rawX, rawY, deadzone);
        int removed = joystickMask & ~next;
        int added = next & ~joystickMask;
        for (int k : KeyMapModel.maskToKeys(removed)) InputBridge.send(k, false);
        for (int k : KeyMapModel.maskToKeys(added)) InputBridge.send(k, true);
        joystickMask = next;
    }

    public int currentJoystickMask() { return joystickMask; }

    public void releaseAll() {
        for (Integer code : pointerKeys.values()) InputBridge.send(code, false);
        pointerKeys.clear();
        pointerX.clear();
        pointerY.clear();
        for (int k : KeyMapModel.maskToKeys(joystickMask)) InputBridge.send(k, false);
        joystickMask = 0;
    }
}
