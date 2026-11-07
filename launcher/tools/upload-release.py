#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""创建 mc-next-v0.4.0 Release 并上传五个产物（AppImage / tar.gz / 原生 APK / Capacitor APK / source）。"""
import os, sys, json, urllib.request, urllib.error

REPO = os.environ.get("MCNEXT_REPO", "leiyihan-ren/mc-mode")
TOKEN = (os.environ.get("GITHUB_TOKEN") or open("/tmp/gh_token").read().strip())
TAG = "mc-next-v0.4.0"
ASSETS = [
    ("/workspace/mc-launcher/release/MC-Next-0.4.0.AppImage", "MC-Next-0.4.0.AppImage"),
    ("/workspace/mc-launcher/release/MC-Next-0.4.0.tar.gz", "MC-Next-0.4.0.tar.gz"),
    ("/workspace/MC-Next-Native-0.4.0.apk", "MC-Next-Native-0.4.0.apk"),
    ("/workspace/MC-Next-Capacitor-0.4.0.apk", "MC-Next-Capacitor-0.4.0.apk"),
    ("/workspace/mc-next-source-0.4.0.tar.gz", "mc-next-source-0.4.0.tar.gz"),
]
UA = "mc-next-release/0.4"

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
    # upload_url 形如 https://uploads.github.com/repos/.../releases/{id}/assets{?name,label}
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
    # 若 release 已存在则复用，否则创建
    try:
        rel = api(f"/repos/{REPO}/releases/tags/{TAG}")
        release_id = rel["id"]
        print(f"[release] 已存在 id={release_id}", flush=True)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rel = api(f"/repos/{REPO}/releases", "POST", {
                "tag_name": TAG,
                "name": "MC-Next v0.4.0 — 全能管家（生态扩展与真实环境适配）",
                "body": (
                    "v0.4.0：从「能启动」进化到「全能管家」。\n\n"
                    "· 模块一 真实 P2P 联机容错：联机大厅创建/加入房间，握手失败自动弹窗"
                    "「请检查防火墙/路由器 UDP 限制」+ 分平台排查步骤/命令/端口/官方文档。\n"
                    "· 模块二 模组与资源包智能管家：真实解析 jar 元数据、启用禁用 rename、"
                    "缺失前置（Fabric API 等）标红、光影材质一键导入、Iris/Oculus/OptiFine 引导。\n"
                    "· 模块三 下载引擎多源加速：BMCLAPI 首选 / Mojang 官方备用 / 指数退避重试 / 重试换源事件。\n\n"
                    "测试 229/229 通过；Electron AppImage+tar.gz、Android 原生 APK、Capacitor APK 均真实构建。"
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
