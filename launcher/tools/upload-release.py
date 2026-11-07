#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""创建 mc-next-v0.6.0 Release 并上传产物（AppImage / tar.gz / 正式签名 APK / 源码包 / latest.yml）。

latest.yml 是本版新增的关键资产：桌面端每次启动会读取
  https://github.com/<repo>/releases/latest/download/latest.yml
因此该 Release 必须被标记为 latest（make_latest=true），且资产名固定为 latest.yml。
"""
import os, sys, json, urllib.request, urllib.error
from pathlib import Path

REPO = os.environ.get("MCNEXT_REPO", "leiyihan-ren/mc-mode")
TOKEN = os.environ.get("GITHUB_TOKEN") or Path("/tmp/gh_token").read_text().strip()
VERSION = "0.6.0"
TAG = f"mc-next-v{VERSION}"
ASSETS = [
    ("/workspace/mc-launcher/release/MC-Next-0.6.0.AppImage", "MC-Next-0.6.0.AppImage"),
    ("/workspace/mc-launcher/release/MC-Next-0.6.0.tar.gz", "MC-Next-0.6.0.tar.gz"),
    ("/workspace/MC-Next-Unified-0.6.0.apk", "MC-Next-Unified-0.6.0.apk"),
    ("/workspace/mc-next-source-0.6.0.tar.gz", "mc-next-source-0.6.0.tar.gz"),
    ("/workspace/mc-launcher/release/latest.yml", "latest.yml"),
]
UA = "mc-next-release/0.6"

BODY = """MC-Next v0.6.0 — 商业级终极压榨：六大模块全量落地。

**模块一 两端 UI 大一统**：废弃简单 WebView 壳，桌面完整 React UI 直接打进原生 APK（Capacitor）；
从 preload 自动生成 Node / JSON / Java 三端指令契约（97 invoke / 15 event / 10 native），
JNI 桥把 UI 指令真实落到 JRE 17 / GL4ES / JVM 状态机 / 输入队列，remote 指令转发 PC 端 /api/rpc。

**模块二 微软 OAuth2 设备码真流程**：RFC 8628 → XBL → XSTS → Minecraft Services → /minecraft/profile
六步链路，后台轮询状态机（authorization_pending / slow_down / expired_token / 取消）、
「复制验证码并打开浏览器」、主页正版玩家卡片（皮肤 / UUID / 名字）；
沙盒无法打开浏览器时提供协议级 Mock，演示账号隔离到 .mock.json，不污染真实账号。

**模块三 JVM 底层监控与调优**：stdout/stderr 汇入 JvmMonitor，解析 JDK9+ -Xlog:gc* 与 JDK8 -verbose:gc，
/proc/<pid>/status VmRSS 真实探针，SVG 折线图性能小雷达，按物理内存生成 Xmx/Xms + G1GC 参数并写入启动指令。

**模块四 Modrinth 在线资源生态**：真实 v2 API（facets 搜索 / 版本 / 依赖递归补全 / 环检测），
一键下载到 mods / shaderpacks / resourcepacks，官方 sha512 校验 + 路径穿越防护 + .part 清理。

**模块五 自动更新与分发**：electron-builder 兼容 latest.yml（真实 sha512/size）、语义化版本比较、
官方直链失败自动回退 gh-proxy 镜像、后台静默下载 + sha512 验签、Android 热更新检查提示（不静默安装 APK）。

**模块六 终局 TDD 与生产构建**：全量 325 项测试全绿（新增 OAuth2 模拟登录 / Modrinth 下载解析 /
JVM 参数生成 / 自动更新断言）；桌面 AppImage + tar.gz；Android 正式版 keystore 签名 APK + apksigner 验签。

边界（不糊弄）：沙盒无 Windows/macOS 代码签名证书，无法产出带 Authenticode / Apple Developer ID 签名的
.exe / .dmg；仓库提供可复现的签名构建脚本与环境变量约定，不伪造签名。Android 使用真实自签名证书，
非 Google Play 上架签名。微软 OAuth2 真实浏览器授权、Modrinth 真实下载、P2P 双节点握手仍受沙盒网络限制，
以协议级 Mock + 明确错误提示替代，不伪造成功。
"""


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
                "name": f"MC-Next v{VERSION} — 商业级终极压榨（大一统 / OAuth2 / JVM 雷达 / Modrinth / 自动更新）",
                "body": BODY,
                "draft": False, "prerelease": False, "make_latest": "true",
            })
            release_id = rel["id"]
            print(f"[release] 已创建 id={release_id}", flush=True)
        else:
            raise
    # 已存在的 Release 也要确保是 latest，否则 /releases/latest/download/latest.yml 会指向旧版
    api(f"/repos/{REPO}/releases/{release_id}", "PATCH", {"make_latest": "true"})
    upload_url = api(f"/repos/{REPO}/releases/{release_id}")["upload_url"]
    existing = {a["name"]: a["id"] for a in api(f"/repos/{REPO}/releases/{release_id}/assets")}
    for fp, name in ASSETS:
        if not os.path.exists(fp):
            print(f"[skip] {name} 不存在", flush=True)
            continue
        if name in existing:
            old = existing[name]
            api(f"/repos/{REPO}/releases/assets/{old}", "DELETE")
            print(f"[replace] 删除同名旧资产 {name}", flush=True)
        print(f"[upload] {name} ({os.path.getsize(fp)//1024//1024} MB) ...", flush=True)
        r = upload_asset(upload_url, fp, name)
        print(f"  -> {r.get('browser_download_url')}", flush=True)
    print("[done] all assets processed", flush=True)


if __name__ == "__main__":
    main()
