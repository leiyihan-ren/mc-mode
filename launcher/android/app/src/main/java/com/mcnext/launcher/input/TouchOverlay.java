package com.mcnext.launcher.input;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

import com.mcnext.launcher.KeyMapModel;

import java.util.ArrayList;
import java.util.List;

/**
 * TouchOverlay — 自绘虚拟按键层（ZL 风格布局），支持多点触控与外接手柄共存
 * 左半屏：虚拟摇杆；右半屏：动作键 + 视角拖动；顶部：快捷栏与菜单。
 */
public class TouchOverlay extends View {
    private static final class Btn {
        final String action, label;
        final RectF rect = new RectF();
        Btn(String action, String label) { this.action = action; this.label = label; }
    }

    private final List<Btn> buttons = new ArrayList<>();
    private final RectF joystick = new RectF();
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private VirtualKeyMapper mapper;
    private int joystickPointer = -1;
    private int lookPointer = -1;
    private float lastLookX, lastLookY;

    public TouchOverlay(Context c, AttributeSet a) {
        super(c, a);
        fill.setStyle(Paint.Style.FILL);
        fill.setColor(Color.argb(70, 120, 200, 255));
        border.setStyle(Paint.Style.STROKE);
        border.setStrokeWidth(2f);
        border.setColor(Color.argb(160, 160, 225, 255));
        labelPaint.setColor(Color.WHITE);
        labelPaint.setTextAlign(Paint.Align.CENTER);
        labelPaint.setTextSize(28f);
        setFocusable(true);
    }

    public void bind(VirtualKeyMapper m) { this.mapper = m; }

    @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) { buildLayout(w, h); }

    private void buildLayout(int w, int h) {
        buttons.clear();
        float r = Math.min(w, h) * 0.085f;
        joystick.set(24, h - 24 - 2 * r, 24 + 2 * r, h - 24);
        add("jump", "跳", w - 130 - 2 * r, h - 110 - 2 * r, r);
        add("attack", "攻", w - 130 - 2 * r, h - 230 - 2 * r, r);
        add("use", "用", w - 250 - 2 * r, h - 170 - 2 * r, r);
        add("inventory", "包", w - 250 - 2 * r, h - 290 - 2 * r, r);
        add("sneak", "潜", w - 370 - 2 * r, h - 110 - 2 * r, r * 0.75f);
        add("sprint", "跑", w - 370 - 2 * r, h - 230 - 2 * r, r * 0.75f);
        add("drop", "丢", w - 480 - 2 * r, h - 110 - 2 * r, r * 0.75f);
        add("menu", "≡", w - 60, 24, r * 0.7f);
        for (int i = 1; i <= 5; i++) {
            add("hotbar" + i, String.valueOf(i), w / 2f - 260 + (i - 1) * 105, 20, r * 0.62f);
        }
    }

    private void add(String action, String label, float cx, float cy, float r) {
        Btn b = new Btn(action, label);
        b.rect.set(cx - r, cy - r, cx + r, cy + r);
        buttons.add(b);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.drawOval(joystick, fill);
        canvas.drawOval(joystick, border);
        canvas.drawText("移动", joystick.centerX(), joystick.centerY() + 10, labelPaint);
        for (Btn b : buttons) {
            canvas.drawRoundRect(b.rect, 18, 18, fill);
            canvas.drawRoundRect(b.rect, 18, 18, border);
            canvas.drawText(b.label, b.rect.centerX(), b.rect.centerY() + 10, labelPaint);
        }
    }

    private Btn hit(float x, float y) {
        for (Btn b : buttons) if (b.rect.contains(x, y)) return b;
        return null;
    }

    /** 0.7.0 模块三：View 被移除（切页 / 崩溃重建）时也必须归零按键状态 */
    @Override protected void onDetachedFromWindow() {
        if (mapper != null) mapper.releaseAll();
        InputBridge.releaseAllHeld();
        joystickPointer = -1;
        lookPointer = -1;
        super.onDetachedFromWindow();
    }

    @Override public boolean onTouchEvent(MotionEvent e) {
        if (mapper == null) return true;
        int action = e.getActionMasked();
        int idx = e.getActionIndex();
        int id = e.getPointerId(idx);
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN:
                handleDown(id, e.getX(idx), e.getY(idx));
                break;
            case MotionEvent.ACTION_MOVE:
                for (int i = 0; i < e.getPointerCount(); i++) {
                    int pid = e.getPointerId(i);
                    float x = e.getX(i), y = e.getY(i);
                    if (pid == joystickPointer) {
                        float nx = clamp((x - joystick.centerX()) / joystick.width() * 2f);
                        float ny = clamp((y - joystick.centerY()) / joystick.height() * 2f);
                        mapper.updateJoystick(nx, ny);
                    } else if (pid == lookPointer) {
                        InputBridge.sendMotion(x - lastLookX, y - lastLookY);
                        lastLookX = x; lastLookY = y;
                    }
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
                mapper.releasePointer(id);
                if (id == joystickPointer) { mapper.updateJoystick(0, 0); joystickPointer = -1; }
                if (id == lookPointer) lookPointer = -1;
                break;
            case MotionEvent.ACTION_CANCEL:
                mapper.releaseAll();
                joystickPointer = -1; lookPointer = -1;
                break;
            default: break;
        }
        return true;
    }

    private void handleDown(int id, float x, float y) {
        Btn b = hit(x, y);
        if (b != null) { mapper.onActionDown(b.action, id, x, y); return; }
        if (joystick.contains(x, y)) {
            joystickPointer = id;
            mapper.updateJoystick(clamp((x - joystick.centerX()) / joystick.width() * 2f),
                                  clamp((y - joystick.centerY()) / joystick.height() * 2f));
            return;
        }
        if (x > getWidth() * 0.45f) { lookPointer = id; lastLookX = x; lastLookY = y; }
    }

    private static float clamp(float v) { return Math.max(-1f, Math.min(1f, v)); }
}
