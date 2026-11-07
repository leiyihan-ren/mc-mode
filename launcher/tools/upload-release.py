#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""创建 mc-next-v0.5.0 Release 并上传五个产物（AppImage / tar.gz / 原生 APK / Capacitor APK / source）。"""
import os, sys, json, urllib.request, urllib.error

REPO = os.environ.get("MCNEXT_REPO", "leiyihan-ren/mc-mode")
TOKEN = (os.environ.get("GITHUB_TOKEN") or open("/tmp/gh_token").read().strip())
TAG = "mc-next-v0.5.0"
ASSETS = [
    ("/workspace/mc-launcher/release/MC-Next-0.5.0.AppImage", "MC-Next-0.5.0.AppImage"),
    ("/workspace/mc-launcher/release/MC-Next-0.5.0.tar.gz", "MC-Next-0.5.0.tar.gz"),
    ("/workspace/MC-Next-Native-0.5.0.apk", "MC-Next-Native-0.5.0.apk"),
    ("/workspace/MC-Next-Capacitor-0.5.0.apk", "MC-Next-Capacitor-0.5.0.apk"),
    ("/workspace/mc-next-source-0.5.0.tar.gz", "mc-next-source-0.5.0.tar.gz"),
]
UA = "mc-next-release/0.5"

def api(path, method="GET", payload=None, base="https://api.github.com"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode() or "{}")

def upload_asset(upload_url, filepath, name):
    url = upload_url.split("{")[0] + f"?name={name}"
    with open(filepath, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": f"Bearer {TOKEN}",
        "User-Agent": UA,
        "Content-Type": "application/octet-stream",
    })
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read().decode() or "{}")

def main():
    try:
        rel = api(f"/repos/{REPO}/releases/tags/{TAG}")
        release_id = rel["id"]
        print(f"[release] 已存在 id={release_id}", flush=True)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rel = api(f"/repos/{REPO}/releases", "POST", {
                "tag_name": TAG,
                "name": "MC-Next v0.5.0 — 极致体验（UI 视觉革命 / 一键分发）",
                "body": (
                    "v0.5.0：从「功能完备」转向「极致体验」。\n\n"
                    "· 模块一 UI 视觉与交互革命：动态背景引擎（深色极简 / Canvas 粒子 / 本地图片+高斯模糊毛玻璃）、"
                    "启动器缩小淡出进入游戏过渡动画、极客 JVM 自定义面板（真实 G1GC 推荐配置一键填入、参数校验与内存托管）。\n"
                    "· 模块二 整合包一键封装与分享：实例管理页一键导出标准 .mrpack（mods/config/options.txt + 依赖版本 + sha256 清单，"
                    "本地模组自包含不伪造直链）、拖拽导入 + 依赖预检拦截（缺失前置 API 明确标红报错而非崩溃）。\n"
                    "· 模块三 沙盒模拟压测：50 模组实例导出→读回→重装闭环、缺失 Fabric API 导入拦截（不创建半成品实例）。\n\n"
                    "全量测试 259/259 通过（既有 229 项零回归）；Electron AppImage+tar.gz、Android 原生 APK、Capacitor APK 均真实构建。"
                ),
                "draft": False, "prerelease": False,
            })
            release_id = rel["id"]
            print(f"[release] 已创建 id={release_id}", flush=True)
        else:
            raise
    upload_url = api(f"/repos/{REPO}/releases/{release_id}")["upload_url"]
    existing = {a["name"]: a["id"] for a in api(f"/repos/{REPO}/releases/{release_id}/assets")}
    for fp, name in ASSETS:
        if not os.path.exists(fp):
            print(f"[skip] {name} 不存在", flush=True); continue
        if name in existing:
            print(f"[dup] {name} 已存在，跳过", flush=True); continue
        print(f"[upload] {name} ({os.path.getsize(fp)//1024//1024} MB) ...", flush=True)
        r = upload_asset(upload_url, fp, name)
        print(f"  -> {r.get('browser_download_url')}", flush=True)
    print("[done] all assets processed", flush=True)

if __name__ == "__main__":
    main()
