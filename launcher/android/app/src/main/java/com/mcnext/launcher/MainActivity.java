package com.mcnext.launcher;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.TextView;

import com.mcnext.launcher.input.GamepadHandler;
import com.mcnext.launcher.input.InputBridge;
import com.mcnext.launcher.input.TouchOverlay;
import com.mcnext.launcher.input.VirtualKeyMapper;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * MainActivity — 原生壳入口：SurfaceView 承载渲染，JNI 起 JVM，触控/手柄层叠加。
 * 不含任何 WebView / Cordova / Capacitor 代码。
 */
public class MainActivity extends Activity implements SurfaceHolder.Callback {
    private TextView status;
    private VirtualKeyMapper mapper;
    private GamepadHandler gamepad;
    private SurfaceView renderSurface;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.status);
        renderSurface = findViewById(R.id.renderSurface);
        TouchOverlay overlay = findViewById(R.id.touchOverlay);
        mapper = new VirtualKeyMapper();
        overlay.bind(mapper);
        gamepad = new GamepadHandler(mapper);
        String saved = getSharedPreferences("mcnext", MODE_PRIVATE).getString("keymap", null);
        if (saved != null) mapper.setLayout(KeyMapModel.layoutFromJson(saved));
        renderSurface.getHolder().addCallback(this);
        renderSurface.getHolder().setFixedSize(1280, 720);
        InputBridge.reset();
        setStatus("准备 Java 运行时… (JNI 状态=" + JvmBridge.jvmStatus() + ")");
        new Thread(this::launchJvm, "mcnext-jvm").start();
    }

    /** 真实启动链路：解压运行时资产 → 校验 JRE → 组装启动参数 → JNI 创建 JVM */
    private void launchJvm() {
        try {
            File home = RuntimeManager.prepare(this);
            if (!RuntimeManager.jreAvailable(this)) {
                setStatus("JRE 未就绪：nativeLibraryDir 中找不到 libjvm.so。\n" +
                          "本 APK 应内置 Android JRE 17 arm64（见 runtime/MANIFEST.json）；" +
                          "若出现此提示说明安装被裁剪，请用 tools/build-apk.sh 重新构建。\n" +
                          "不会伪造运行结果。");
                return;
            }
            LaunchConfig cfg = loadConfig(home);
            setStatus("JVM 启动中 | " + cfg.version + " | " + cfg.renderer +
                      " | mainClass=" + cfg.mainClass);
            int code = JvmBridge.launch(this, cfg);
            String err = JvmBridge.lastError();
            setStatus("JVM 已退出 code=" + code + (err == null || err.isEmpty() ? "" : "\n" + err));
        } catch (Throwable t) {
            setStatus("启动失败: " + t.getClass().getSimpleName() + ": " + t.getMessage());
        }
    }

    /**
     * 从桌面端导出的 launch.json 读取实例配置（与桌面端 version.json 语义一致）。
     * 文件不存在时给出明确提示，而不是用假数据启动。
     */
    private LaunchConfig loadConfig(File runtimeHome) throws Exception {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        File cfgFile = new File(base, "launch.json");
        LaunchConfig c = new LaunchConfig();
        c.javaHome = runtimeHome.getAbsolutePath();
        c.libraryPath = RuntimeManager.nativeLibDir(this);
        c.gameDir = new File(base, "instances/default/.minecraft").getAbsolutePath();
        c.assetsDir = new File(base, "assets").getAbsolutePath();
        c.classpath = new File(base, "instances/default/classpath.txt").getAbsolutePath();
        if (!cfgFile.exists()) {
            throw new IllegalStateException("缺少 launch.json（" + cfgFile.getAbsolutePath() +
                    "）：请用桌面端「导出移动端启动配置」生成，包含 mainClass 与完整 classpath");
        }
        JSONObject j = new JSONObject(new String(Files.readAllBytes(cfgFile.toPath()), StandardCharsets.UTF_8));
        c.version = j.optString("version", c.version);
        c.mainClass = j.optString("mainClass", c.mainClass);
        c.classpath = j.optString("classpath", c.classpath);
        c.gameDir = j.optString("gameDir", c.gameDir);
        c.assetsDir = j.optString("assetsDir", c.assetsDir);
        c.assetIndex = j.optString("assetIndex", c.assetIndex);
        c.versionType = j.optString("versionType", c.versionType);
        c.username = j.optString("username", c.username);
        c.uuid = j.optString("uuid", c.uuid);
        c.accessToken = j.optString("accessToken", "");
        c.renderer = j.optString("renderer", "gl4es");
        c.width = j.optInt("width", c.width);
        c.height = j.optInt("height", c.height);
        c.maxMemoryMb = j.optInt("maxMemoryMb", c.maxMemoryMb);
        c.minMemoryMb = j.optInt("minMemoryMb", c.minMemoryMb);
        return c.validate();
    }

    private void setStatus(String s) {
        runOnUiThread(() -> status.setText(s));
    }

    // ---- Surface 生命周期：把 ANativeWindow 交给渲染后端 ----
    @Override public void surfaceCreated(SurfaceHolder h) { JvmBridge.setSurface(h.getSurface()); }
    @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { }
    @Override public void surfaceDestroyed(SurfaceHolder h) { JvmBridge.setSurface(null); }

    // ---- 外接手柄 ----
    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if ((e.getSource() & android.view.InputDevice.SOURCE_GAMEPAD) != 0) {
            boolean handled = e.getAction() == KeyEvent.ACTION_DOWN
                    ? gamepad.onKeyDown(e.getKeyCode()) : gamepad.onKeyUp(e.getKeyCode());
            if (handled) return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override public boolean dispatchGenericMotionEvent(MotionEvent e) {
        if (gamepad.onMotionEvent(e)) return true;
        return super.dispatchGenericMotionEvent(e);
    }

    @Override protected void onDestroy() {
        mapper.releaseAll();
        JvmBridge.setSurface(null);
        super.onDestroy();
    }
}
