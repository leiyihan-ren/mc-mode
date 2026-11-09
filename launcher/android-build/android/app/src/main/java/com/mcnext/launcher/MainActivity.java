package com.mcnext.launcher;

import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.BridgeActivity;
import com.mcnext.launcher.input.InputBridge;

/**
 * MainActivity — 0.6.0 大一统入口：Capacitor 承载完整 React UI，叠加真实渲染 Surface。
 *
 * 与旧「简单 WebView 壳」的本质区别：
 *  1. 注册 McNextBridgePlugin，window.mcnext 的指令可直达 JNI / JRE17；
 *  2. 动态叠加 SurfaceView，JvmBridge.setSurface() 把 ANativeWindow 交给 GL4ES；
 *  3. JVM 启动时把 Surface 置顶，退出后隐藏，UI 与游戏渲染在同一 APK 内共存。
 *
 * 0.7.0 模块三：在切后台 / 失去焦点 / 销毁时强制释放所有虚拟按键，
 * 避免收不到 ACTION_UP 导致游戏内「一直前进 / 一直跳跃」卡死。
 *
 * 旧的原生 SurfaceView-only Activity 保留在 android/app（Native APK 构建用），
 * 本文件由 tools/build-unified-apk.sh 同步进 Capacitor 工程覆盖同名类。
 */
public class MainActivity extends BridgeActivity {

    private SurfaceView surfaceView;
    private NativeCommandRouter router;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(IntentPlugin.class);
        registerPlugin(McNextBridgePlugin.class);

        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().setFixedSize(1280, 720);
        surfaceView.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder h) { JvmBridge.setSurface(h.getSurface()); }
            @Override
            public void surfaceChanged(SurfaceHolder h, int format, int w, int hh) { }
            @Override
            public void surfaceDestroyed(SurfaceHolder h) {
                InputBridge.releaseAllHeld();   // Surface 消失时按键状态必须归零
                JvmBridge.setSurface(null);
            }
        });
        addContentView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        surfaceView.setVisibility(View.GONE);

        if (router != null) bindRouter(router);
    }

    /** 由 McNextBridgePlugin.load() 调用，可能在 surfaceView 创建之前，故 show() 内做空判 */
    public void bindRouter(NativeCommandRouter r) {
        this.router = r;
        r.setSurfaceProvider(new NativeCommandRouter.SurfaceProvider() {
            @Override
            public void show() {
                runOnUiThread(() -> {
                    if (surfaceView == null) return;
                    surfaceView.setVisibility(View.VISIBLE);
                    surfaceView.bringToFront();
                });
            }
            @Override
            public void hide() {
                runOnUiThread(() -> {
                    if (surfaceView != null) surfaceView.setVisibility(View.GONE);
                });
            }
        });
    }

    @Override
    public void onPause() {
        InputBridge.releaseAllHeld();
        super.onPause();
    }

    @Override
    public void onStop() {
        InputBridge.releaseAllHeld();
        super.onStop();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) InputBridge.releaseAllHeld();
    }

    @Override
    public void onDestroy() {   // BridgeActivity 中为 public，覆盖时不能降低可见性
        InputBridge.releaseAllHeld();
        JvmBridge.setSurface(null);
        super.onDestroy();
    }
}
