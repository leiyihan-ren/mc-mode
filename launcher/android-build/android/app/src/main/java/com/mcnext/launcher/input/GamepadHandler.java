package com.mcnext.launcher.input;

import android.view.KeyEvent;
import android.view.MotionEvent;

import com.mcnext.launcher.KeyMapModel;

/**
 * GamepadHandler — 外接手柄（Xbox / PS / 蓝牙手柄）输入
 *  - 按钮：KEYCODE_BUTTON_* → LWJGL 键码 / 鼠标按钮
 *  - 左摇杆：AXIS_X / AXIS_Y → WASD 差量
 *  - 右摇杆：AXIS_Z / AXIS_RZ → 视角（相对鼠标位移）
 *  - 扳机：AXIS_LTRIGGER / AXIS_RTRIGGER / AXIS_BRAKE / AXIS_GAS → 使用 / 攻击
 */
public final class GamepadHandler {
    private static final float DEADZONE = 0.15f;
    private final VirtualKeyMapper mapper;
    private int triggerState = 0;

    public GamepadHandler(VirtualKeyMapper mapper) { this.mapper = mapper; }

    public boolean onKeyDown(int keyCode) {
        int code = KeyMapModel.gamepadButton(keyCode);
        if (code == 0) return false;
        InputBridge.send(code, true);
        return true;
    }

    public boolean onKeyUp(int keyCode) {
        int code = KeyMapModel.gamepadButton(keyCode);
        if (code == 0) return false;
        InputBridge.send(code, false);
        return true;
    }

    public boolean onMotionEvent(MotionEvent e) {
        if (e == null || (e.getSource() & android.view.InputDevice.SOURCE_JOYSTICK) == 0) return false;
        float lx = KeyMapModel.applyDeadzone(e.getAxisValue(MotionEvent.AXIS_X), DEADZONE);
        float ly = KeyMapModel.applyDeadzone(e.getAxisValue(MotionEvent.AXIS_Y), DEADZONE);
        mapper.updateJoystick(lx, ly);

        float rx = KeyMapModel.applyDeadzone(e.getAxisValue(MotionEvent.AXIS_Z), DEADZONE);
        float ry = KeyMapModel.applyDeadzone(e.getAxisValue(MotionEvent.AXIS_RZ), DEADZONE);
        if (Math.abs(rx) > 0.001f || Math.abs(ry) > 0.001f) {
            InputBridge.sendMotion(rx * 18f, ry * 18f);
        }

        float l2 = Math.max(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE));
        float r2 = Math.max(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS));
        int next = KeyMapModel.triggerToMouse(l2, r2, 0.5f);
        if (next != triggerState) {
            if (triggerState != 0) InputBridge.send(triggerState, false);
            if (next != 0) InputBridge.send(next, true);
            triggerState = next;
        }
        return true;
    }
}
