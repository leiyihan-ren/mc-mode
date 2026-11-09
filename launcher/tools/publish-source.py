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
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = json.loads((ROOT / "package.json").read_text())
CFG = json.loads((ROOT / "config/release.json").read_text())
# 0.9.0：仓库 / 版本 / 标题全部来自配置，消除跨版本硬编码（单一数据源）。
REPO = os.environ.get("MCNEXT_REPO") or CFG["repo"].split("github.com/")[-1].strip("/")
VERSION = PKG["version"]
TITLE = CFG.get("title", "版本发布")
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


# 0.9.0：409 个 blob 逐个 POST 时，GitHub 可能瞬时断连 / 限流（尤其与 Release 大文件
# 上传并发时）。对「连接类瞬时错误 + 5xx + 429」做指数退避重试，绝不中断整批推送。
RETRY_MAX = int(os.environ.get("MCNEXT_API_RETRIES", "5"))
RETRYABLE_HTTP = {429, 500, 502, 503, 504}


def api(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    last = None
    for attempt in range(RETRY_MAX + 1):
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "User-Agent": f"mc-next-publisher/{VERSION}",
            "Content-Type": "application/json"
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in RETRYABLE_HTTP or attempt >= RETRY_MAX:
                raise
            wait = min(2 ** attempt, 16)
            print(f"  [retry] HTTP {e.code} {method} {path} → {wait}s 后重试({attempt + 1}/{RETRY_MAX})", flush=True)
            time.sleep(wait)
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            # RemoteDisconnected 是 URLError/OSError 子类；blob POST 可安全重试（幂等创建）
            last = e
            if attempt >= RETRY_MAX:
                raise
            wait = min(2 ** attempt, 16)
            print(f"  [retry] 连接中断 {type(e).__name__} → {wait}s 后重试({attempt + 1}/{RETRY_MAX})", flush=True)
            time.sleep(wait)
    raise last  # pragma: no cover


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
        "message": f"feat: MC-Next v{VERSION} — {TITLE}",
        "tree": tree["sha"], "parents": [ref]
    })
    api(f"/repos/{REPO}/git/refs/heads/main", "PATCH", {"sha": commit["sha"]})
    print(f"[done] main -> {commit['sha']}", flush=True)
    print(f"[done] https://github.com/{REPO}/tree/main/{PREFIX.rstrip('/')}", flush=True)


if __name__ == "__main__":
    main()
