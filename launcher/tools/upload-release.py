#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""创建 MC-Next Release 并上传产物（AppImage / tar.gz / 正式签名 APK / 源码包 / latest.yml）。

0.9.0：版本、tag、资产名全部来自 package.json + config/release.json（单一数据源），
不再硬编码；Release 正文外置到 config/release-body.md。任何版本发布只需 bump 配置即可复现。

latest.yml 是自动更新的关键资产：桌面端读取
  https://github.com/<repo>/releases/latest/download/latest.yml
因此该 Release 必须 make_latest=true，且资产名固定为 latest.yml。

用法: GITHUB_TOKEN=xxx python3.11 tools/upload-release.py
"""
import os, sys, json, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = json.loads((ROOT / "package.json").read_text())
CFG = json.loads((ROOT / "config/release.json").read_text())
REPO = os.environ.get("MCNEXT_REPO") or CFG["repo"].split("github.com/")[-1].strip("/")
TOKEN = os.environ.get("GITHUB_TOKEN") or Path("/tmp/gh_token").read_text().strip()
VERSION = PKG["version"]
TAG = CFG["tag"]
TITLE = CFG.get("title", "版本发布")
A = CFG["assets"]
ASSETS = [
    (str(ROOT / "release" / A["appImage"]), A["appImage"]),
    (str(ROOT / "release" / A["tarGz"]), A["tarGz"]),
    (f"/workspace/{A['apk']}", A["apk"]),
    (f"/workspace/{A['source']}", A["source"]),
    (str(ROOT / "release" / A["latestYml"]), A["latestYml"]),
]
UA = f"mc-next-release/{VERSION}"
BODY_FILE = ROOT / "config/release-body.md"
BODY = BODY_FILE.read_text() if BODY_FILE.exists() else f"MC-Next v{VERSION} — {TITLE}"


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
    print(f"[release] 目标 {REPO} · tag={TAG} · version={VERSION}", flush=True)
    # 发布前强制校验：缺任一资产就拒绝发布，绝不静默 skip 出一个不完整 Release
    missing = [name for fp, name in ASSETS if not os.path.exists(fp)]
    for fp, name in ASSETS:
        ok = os.path.exists(fp)
        print(f"  {'OK  ' if ok else 'MISS'} {name}"
              + (f" ({os.path.getsize(fp)//1024//1024} MB)" if ok else f" <- {fp}"), flush=True)
    if missing:
        print(f"[abort] 缺少 {len(missing)} 个产物，拒绝发布: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    try:
        rel = api(f"/repos/{REPO}/releases/tags/{TAG}")
        release_id = rel["id"]
        print(f"[release] 已存在 id={release_id}", flush=True)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            rel = api(f"/repos/{REPO}/releases", "POST", {
                "tag_name": TAG,
                "name": f"MC-Next v{VERSION} — {TITLE}",
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
