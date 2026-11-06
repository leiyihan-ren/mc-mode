package com.mcnext.launcher;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * KeyMapModel — 虚拟按键 / 手柄映射的纯逻辑内核（无 Android 依赖，可 JVM 单测）
 *
 * 键码采用真实 LWJGL 2 常量；负数代表鼠标按钮（与 Zalith Launcher 的
 * CallbackBridge 语义一致：JVM 侧把负数转成 glfwSetMouseButton 调用）。
 *
 * 映射表可序列化为 JSON 存到 SharedPreferences，实现自定义布局与外接手柄重绑定。
 */
public final class KeyMapModel {
    private KeyMapModel() {}

    // ---- 真实 LWJGL 2 键码 ----
    public static final int KEY_ESCAPE = 0x01;
    public static final int KEY_1 = 0x02, KEY_2 = 0x03, KEY_3 = 0x04, KEY_4 = 0x05, KEY_5 = 0x06;
    public static final int KEY_TAB = 0x0F, KEY_Q = 0x10, KEY_W = 0x11, KEY_E = 0x12;
    public static final int KEY_R = 0x13, KEY_T = 0x14, KEY_F = 0x21;
    public static final int KEY_LCONTROL = 0x1D;
    public static final int KEY_A = 0x1E, KEY_S = 0x1F, KEY_D = 0x20;
    public static final int KEY_LSHIFT = 0x2A;
    public static final int KEY_SPACE = 0x39;
    public static final int KEY_F2 = 0x3C, KEY_F3 = 0x3D, KEY_F5 = 0x3F;
    public static final int KEY_LMENU = 0x38;

    // ---- 鼠标按钮（负数，JVM 侧转 glfwSetMouseButton）----
    public static final int MOUSE_LEFT = -1;
    public static final int MOUSE_RIGHT = -2;
    public static final int MOUSE_MIDDLE = -3;

    // ---- Android KeyEvent 手柄按钮数值（避免引入 android.* 以便 JVM 单测）----
    public static final int GP_DPAD_UP = 19, GP_DPAD_DOWN = 20, GP_DPAD_LEFT = 21, GP_DPAD_RIGHT = 22;
    public static final int GP_BUTTON_A = 96, GP_BUTTON_B = 97, GP_BUTTON_C = 98;
    public static final int GP_BUTTON_X = 99, GP_BUTTON_Y = 100, GP_BUTTON_Z = 101;
    public static final int GP_BUTTON_L1 = 102, GP_BUTTON_R1 = 103;
    public static final int GP_BUTTON_L2 = 104, GP_BUTTON_R2 = 105;
    public static final int GP_BUTTON_SELECT = 109, GP_BUTTON_START = 108;
    public static final int GP_BUTTON_THUMBL = 106, GP_BUTTON_THUMBR = 107;

    // ---- 摇杆方向位掩码 ----
    public static final int MASK_FORWARD = 1, MASK_BACK = 2, MASK_LEFT = 4, MASK_RIGHT = 8;

    /** 死区处理：小于阈值归零，其余线性重映射，避免摇杆漂移 */
    public static float applyDeadzone(float v, float deadzone) {
        float d = deadzone < 0 ? 0 : (deadzone > 0.9f ? 0.9f : deadzone);
        float a = Math.abs(v);
        if (a <= d) return 0f;
        float remapped = (a - d) / (1f - d);
        return Math.signum(v) * Math.min(1f, remapped);
    }

    /** 左摇杆 (x,y) → 方向位掩码 */
    public static int axisMask(float rawX, float rawY, float deadzone) {
        float x = applyDeadzone(rawX, deadzone);
        float y = applyDeadzone(rawY, deadzone);
        int mask = 0;
        if (y < -0.001f) mask |= MASK_FORWARD;
        if (y >  0.001f) mask |= MASK_BACK;
        if (x < -0.001f) mask |= MASK_LEFT;
        if (x >  0.001f) mask |= MASK_RIGHT;
        return mask;
    }

    /** 位掩码 → 需要按下/抬起的 LWJGL 键码集合 */
    public static int[] maskToKeys(int mask) {
        int n = Integer.bitCount(mask & 0xF);
        int[] out = new int[n];
        int i = 0;
        if ((mask & MASK_FORWARD) != 0) out[i++] = KEY_W;
        if ((mask & MASK_BACK) != 0)    out[i++] = KEY_S;
        if ((mask & MASK_LEFT) != 0)    out[i++] = KEY_A;
        if ((mask & MASK_RIGHT) != 0)   out[i++] = KEY_D;
        return out;
    }

    /** 默认虚拟按键布局（ZL 风格：左摇杆 + 右侧动作键 + 快捷栏） */
    public static Map<String, Integer> defaultLayout() {
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("forward",  KEY_W);
        m.put("back",     KEY_S);
        m.put("left",     KEY_A);
        m.put("right",    KEY_D);
        m.put("jump",     KEY_SPACE);
        m.put("sneak",    KEY_LSHIFT);
        m.put("sprint",   KEY_LCONTROL);
        m.put("inventory",KEY_E);
        m.put("drop",     KEY_Q);
        m.put("chat",     KEY_T);
        m.put("attack",   MOUSE_LEFT);
        m.put("use",      MOUSE_RIGHT);
        m.put("hotbar1",  KEY_1);
        m.put("hotbar2",  KEY_2);
        m.put("hotbar3",  KEY_3);
        m.put("hotbar4",  KEY_4);
        m.put("hotbar5",  KEY_5);
        m.put("menu",     KEY_ESCAPE);
        m.put("perspective", KEY_F5);
        m.put("screenshot",  KEY_F2);
        return m;
    }

    /** 手柄按钮 → 键码 / 鼠标按钮；未绑定返回 0 */
    public static int gamepadButton(int androidKeyCode) {
        switch (androidKeyCode) {
            case GP_BUTTON_A:      return KEY_SPACE;    // 跳跃
            case GP_BUTTON_B:      return KEY_E;        // 背包
            case GP_BUTTON_X:      return MOUSE_LEFT;   // 攻击
            case GP_BUTTON_Y:      return MOUSE_RIGHT;  // 使用/放置
            case GP_BUTTON_L1:     return KEY_Q;        // 丢弃
            case GP_BUTTON_R1:     return KEY_F5;       // 视角
            case GP_BUTTON_START:  return KEY_ESCAPE;   // 菜单
            case GP_BUTTON_SELECT: return KEY_F3;       // 调试信息
            case GP_BUTTON_THUMBL: return KEY_LSHIFT;   // 潜行
            case GP_BUTTON_THUMBR: return KEY_LCONTROL; // 疾跑
            case GP_DPAD_UP:       return KEY_W;
            case GP_DPAD_DOWN:     return KEY_S;
            case GP_DPAD_LEFT:     return KEY_A;
            case GP_DPAD_RIGHT:    return KEY_D;
            default: return 0;
        }
    }

    /** 扳机 → 攻击/使用（阈值 0.5） */
    public static int triggerToMouse(float l2, float r2, float threshold) {
        if (l2 > threshold) return MOUSE_RIGHT;
        if (r2 > threshold) return MOUSE_LEFT;
        return 0;
    }

    public static boolean isMouse(int code) { return code < 0; }

    /** 布局序列化（轻量 JSON，避免引入第三方库） */
    public static String layoutToJson(Map<String, Integer> layout) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Integer> e : layout.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(e.getKey().replace("\"", "")).append("\":").append(e.getValue());
        }
        return sb.append('}').toString();
    }

    public static Map<String, Integer> layoutFromJson(String json) {
        Map<String, Integer> m = new LinkedHashMap<>();
        if (json == null) return m;
        String body = json.trim().replaceAll("^\\{|\\}$", "");
        if (body.isEmpty()) return m;
        for (String pair : body.split(",")) {
            String[] kv = pair.split(":", 2);
            if (kv.length != 2) continue;
            String k = kv[0].trim().replaceAll("^\"|\"$", "");
            try { m.put(k, Integer.parseInt(kv[1].trim())); } catch (NumberFormatException ignored) { }
        }
        return m;
    }

    public static String keyName(int code) {
        switch (code) {
            case KEY_W: return "W"; case KEY_A: return "A"; case KEY_S: return "S"; case KEY_D: return "D";
            case KEY_SPACE: return "空格"; case KEY_LSHIFT: return "Shift"; case KEY_LCONTROL: return "Ctrl";
            case KEY_E: return "E"; case KEY_Q: return "Q"; case KEY_T: return "T"; case KEY_ESCAPE: return "Esc";
            case KEY_F5: return "F5"; case KEY_F2: return "F2";
            case MOUSE_LEFT: return "左键"; case MOUSE_RIGHT: return "右键"; case MOUSE_MIDDLE: return "中键";
            default: return "KEY_" + code;
        }
    }
}
