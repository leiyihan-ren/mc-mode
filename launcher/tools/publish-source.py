#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
publish-source.py — 把 MC-Next 源码提交到既有仓库 main 分支的 launcher/ 目录。

用 GitHub Git Data API（blobs → trees → commits → PATCH refs），无需 clone 2GB 数据仓库。
只推送文本源码；大二进制（JRE/渲染库/测试 Jar/构建产物）由 Release 源码包与
android/tools/fetch-runtime.py 复现，不进 git。

用法: GITHUB_TOKEN=xxx python3.11 tools/publish-source.py
"""
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = os.environ.get("MCNEXT_REPO", "leiyihan-ren/mc-mode")
PREFIX = "launcher/"
TOKEN = os.environ.get("GITHUB_TOKEN") or Path("/tmp/gh_token").read_text().strip()
API = "https://api.github.com"

# 0.4.0：不再整体排除 android-build，让 Capacitor 构建脚本/配置一并进 main；
# 仅排除其中的构建产物与依赖目录。
EXCLUDE_DIRS = {
    "node_modules", "dist", "release", ".git", ".gradle", "build", ".cxx",
    "jniLibs", "runtime/download", "assets/runtime", "www", "public", "__pycache__"
}
EXCLUDE_SUFFIX = {".jar", ".apk", ".zip", ".xz", ".so", ".AppImage", ".gz", ".log", ".class", ".dex"}
MAX_BYTES = 2 * 1024 * 1024


def api(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "mc-next-publisher/0.2",
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode() or "{}")


def should_skip(rel):
    parts = set(Path(rel).parts)
    if parts & EXCLUDE_DIRS:
        return True
    if Path(rel).suffix.lower() in EXCLUDE_SUFFIX:
        return True
    if rel.startswith("core."):
        return True
    return False


def main():
    files = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if should_skip(rel):
            continue
        if p.stat().st_size > MAX_BYTES:
            continue
        try:
            content = p.read_bytes()
            content.decode("utf-8")  # 只提交文本源码
        except (UnicodeDecodeError, OSError):
            continue
        files.append((rel, content))
    print(f"[collect] {len(files)} 个文本源码文件", flush=True)

    ref = api(f"/repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    base_commit = api(f"/repos/{REPO}/git/commits/{ref}")
    base_tree = base_commit["tree"]["sha"]
    print(f"[ref] main = {ref}", flush=True)

    entries = []
    for i, (rel, content) in enumerate(files, 1):
        blob = api(f"/repos/{REPO}/git/blobs", "POST", {
            "content": base64.b64encode(content).decode(), "encoding": "base64"
        })
        mode = "100755" if rel.endswith(".sh") or rel.endswith(".py") else "100644"
        entries.append({"path": PREFIX + rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
        if i % 30 == 0:
            print(f"  blob {i}/{len(files)}", flush=True)

    tree = api(f"/repos/{REPO}/git/trees", "POST", {"base_tree": base_tree, "tree": entries})
    commit = api(f"/repos/{REPO}/git/commits", "POST", {
        "message": "feat: MC-Next 0.5.0 极致体验（动态背景/启动动画/极客 JVM 面板 / 整合包一键导出导入 / 沙盒压测）",
        "tree": tree["sha"], "parents": [ref]
    })
    api(f"/repos/{REPO}/git/refs/heads/main", "PATCH", {"sha": commit["sha"]})
    print(f"[done] main -> {commit['sha']}", flush=True)
    print(f"[done] https://github.com/{REPO}/tree/main/{PREFIX.rstrip('/')}", flush=True)


if __name__ == "__main__":
    main()
