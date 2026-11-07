package com.mcnext.launcher;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** IntentBridge — 唤起第三方 MC 启动器 / 打开外部链接（大一统 APK 保留的原生能力）。 */
@CapacitorPlugin(name = "IntentBridge")
public class IntentPlugin extends Plugin {

    @PluginMethod
    public void openApp(PluginCall call) {
        String pkg = call.getString("packageName", "net.kdt.pojavlaunch");
        android.content.Context ctx = getBridge().getContext();
        Intent intent = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                ctx.startActivity(intent);
                call.resolve();
                return;
            } catch (Exception e) {
                call.reject("LAUNCH_FAILED", e.getMessage());
                return;
            }
        }
        try {
            Intent market = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://search?q=" + pkg + "&c=apps"));
            market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(market);
            call.reject("APP_NOT_FOUND_OPENED_MARKET");
        } catch (Exception e) {
            call.reject("APP_NOT_FOUND");
        }
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        String pkg = call.getString("packageName", "net.kdt.pojavlaunch");
        try {
            getBridge().getContext().getPackageManager().getPackageInfo(pkg, 0);
            JSObject ret = new JSObject();
            ret.put("installed", true);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("installed", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.isEmpty()) { call.reject("NO_URL"); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getBridge().getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("OPEN_FAILED", e.getMessage());
        }
    }
}
