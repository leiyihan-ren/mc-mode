#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
fetch-runtime.py — 把真实 Android JRE 与 GL4ES/LWJGL 原生库装进 APK 工程。

真实来源（可独立校验，不含任何占位/伪造二进制）：
  1) JRE 17 arm64 (Android .so 构建)
     https://github.com/PojavLauncherTeam/android-openjdk-build-multiarch/releases/download/jre17-ec28559/jre17-arm64-20210825-release.tar.xz
  2) 渲染 / 输入 natives (GL4ES, LWJGL, OpenAL, freetype, OSMesa, Vulkan)
     从 PojavLauncher gladiolus APK 的 lib/arm64-v8a/ 目录按需抽取
     （用 HTTP Range 读远程 zip 中央目录，只下载需要的条目，不下 154MB 整包）

Android 10+ W^X 约束：所有 .so 必须打进 APK 的 lib/arm64-v8a/，
运行时由系统安装到 nativeLibraryDir；JRE 数据文件放 assets/runtime，
RuntimeManager.prepare() 首次启动复制到 filesDir/runtime 并作为 -Djava.home。

用法：
  python3.11 tools/fetch-runtime.py --jre /path/to/jre17-arm64.tar.xz
  python3.11 tools/fetch-runtime.py            # 自动下载 JRE
产物：
  app/src/main/jniLibs/arm64-v8a/*.so
  app/src/main/assets/runtime/**               （JRE 根：lib/modules, conf/, bin/ ...）
  runtime/MANIFEST.json                        （每个来源的 sha256 / 文件数 / 字节数）
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app" / "src" / "main"
JNILIBS = APP / "jniLibs" / "arm64-v8a"
ASSETS = APP / "assets" / "runtime"
DOWNLOADS = ROOT / "runtime" / "download"

JRE_URL = ("https://github.com/PojavLauncherTeam/android-openjdk-build-multiarch/"
           "releases/download/jre17-ec28559/jre17-arm64-20210825-release.tar.xz")
JRE_MIRROR = "https://gh-proxy.com/" + JRE_URL
POJAV_APK = ("https://gh-proxy.com/https://github.com/PojavLauncherTeam/PojavLauncher/"
             "releases/download/gladiolus/PojavLauncher.apk")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, dest):
    print(f"[download] {url} -> {dest.name}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "mc-next/0.2"})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1024 * 1024)
            if not b:
                break
            f.write(b)
    return dest


def extract_jre(archive):
    """JRE 的 .so -> jniLibs（server/ 优先）；其余文件 -> assets/runtime（保持 JRE 根结构）"""
    JNILIBS.mkdir(parents=True, exist_ok=True)
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    ASSETS.mkdir(parents=True)

    so_count, data_count, data_bytes = 0, 0, 0
    # 同名 .so 冲突时 lib/server/ 版本优先（libjvm.so 所在目录）
    pending = {}
    with tarfile.open(archive, "r:xz") as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            name = m.name.lstrip("./")
            fobj = tf.extractfile(m)
            if fobj is None:
                continue
            data = fobj.read()
            if name.endswith(".so"):
                base = os.path.basename(name)
                prio = 1 if "/server/" in "/" + name else 0
                if base not in pending or prio >= pending[base][0]:
                    pending[base] = (prio, data)
            else:
                out = ASSETS / name
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
                data_count += 1
                data_bytes += len(data)
                if name.startswith("bin/"):
                    out.chmod(0o755)
    for base, (_, data) in pending.items():
        (JNILIBS / base).write_bytes(data)
        so_count += 1
    print(f"[jre] .so -> jniLibs: {so_count} 个；数据 -> assets/runtime: {data_count} 个 / "
          f"{data_bytes / 1024 / 1024:.1f} MB", flush=True)
    return {"jre_so_count": so_count, "jre_data_files": data_count, "jre_data_bytes": data_bytes}


def extract_pojav_natives():
    """HTTP Range 读远程 APK 的 lib/arm64-v8a/*.so，只下载需要的条目"""
    try:
        from remotezip import RemoteZip
    except ImportError:
        print("[warn] 缺少 remotezip，跳过渲染库抽取（python3.11 -m pip install remotezip）", file=sys.stderr)
        return {"render_so_count": 0, "render_so_bytes": 0, "error": "remotezip missing"}
    JNILIBS.mkdir(parents=True, exist_ok=True)
    count, total = 0, 0
    with RemoteZip(POJAV_APK) as z:
        targets = [n for n in z.namelist()
                   if n.startswith("lib/arm64-v8a/") and n.endswith(".so")]
        for n in targets:
            base = os.path.basename(n)
            out = JNILIBS / base
            if out.exists():
                continue  # JRE 提供的同名库优先，避免破坏 JVM 依赖
            data = z.read(n)
            out.write_bytes(data)
            count += 1
            total += len(data)
            print(f"  + {base} ({len(data) / 1024:.0f} KB)", flush=True)
    print(f"[pojav] 渲染/输入 .so: {count} 个 / {total / 1024 / 1024:.1f} MB", flush=True)
    return {"render_so_count": count, "render_so_bytes": total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jre", help="本地 JRE tar.xz；不给则自动下载")
    ap.add_argument("--skip-pojav", action="store_true", help="跳过远程渲染库抽取")
    args = ap.parse_args()

    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    jre = Path(args.jre).resolve() if args.jre else DOWNLOADS / "jre17-android.tar.xz"
    if not jre.exists():
        try:
            download(JRE_MIRROR, jre)
        except Exception as e:
            print(f"[warn] 镜像失败({e})，回退官方源", flush=True)
            download(JRE_URL, jre)

    manifest = {
        "schema": 1,
        "abi": "arm64-v8a",
        "jre": {
            "url": JRE_URL,
            "archive": str(jre.relative_to(ROOT)),
            "sha256": sha256(jre),
            "bytes": jre.stat().st_size,
        },
        "render_libs": {
            "source": POJAV_APK,
            "note": "APK lib/arm64-v8a/ 下真实 GL4ES/LWJGL/OpenAL/freetype/OSMesa/Vulkan natives",
        },
    }
    manifest["jre"].update(extract_jre(jre))
    if not args.skip_pojav:
        manifest["render_libs"].update(extract_pojav_natives())
    manifest["jniLibs_total"] = len(list(JNILIBS.glob("*.so")))
    manifest["assets_runtime_total"] = sum(1 for p in ASSETS.rglob("*") if p.is_file())

    out = ROOT / "runtime" / "MANIFEST.json"
    out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[done] jniLibs .so = {manifest['jniLibs_total']}, "
          f"assets/runtime files = {manifest['assets_runtime_total']}\n"
          f"[done] manifest: {out}", flush=True)


if __name__ == "__main__":
    main()
