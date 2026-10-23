#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minecraft 模组加载器安装工具 —— 自动下载安装包并无头安装。

用法：
  python3 modloader.py list <loader> [mc_version]        列出可用版本
  python3 modloader.py <loader> <mc_version> [--build B] [--dir D]   安装
loader: fabric | quilt | forge | neoforge
示例：
  python3 modloader.py fabric 1.21.11
  python3 modloader.py neoforge 1.21.11 --dir /data/server
  python3 modloader.py forge 1.20.1 --build 47.1.79
  python3 modloader.py list neoforge 1.21.11
"""
import argparse, json, os, subprocess, sys, tempfile, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = json.load(open(os.path.join(ROOT, "modloaders.json"), encoding="utf-8"))
SERVER = False

def human(n):
    if not n: return "-"
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024: return f"{f:.1f}{u}"
        f /= 1024
    return f"{f:.1f}TB"

def http_get(url, dest=None, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "mc-modloader/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    if dest:
        open(dest, "wb").write(raw)
    return raw

def pick_loader(loader, mc, build=None):
    if loader in ("fabric", "quilt"):
        games = DATA[loader]["games"]
        if mc not in games:
            print(f"[错误] {loader} 不支持 MC {mc}"); sys.exit(1)
        g = games[mc]
        ver = build or g["stable"] or g["beta"]
        return ver
    if loader == "forge":
        latest = DATA["forge"]["latest"].get(mc)
        builds = DATA["forge"]["builds"].get(mc, [])
        if not builds:
            print(f"[错误] Forge 不支持 MC {mc}"); sys.exit(1)
        return build or latest.split("-", 1)[1]
    if loader == "neoforge":
        builds = DATA["neoforge"]["builds"].get(mc, []) or DATA["neoforge"]["legacy_1_20_1"].get(mc, [])
        if not builds:
            print(f"[错误] NeoForge 不支持 MC {mc}"); sys.exit(1)
        return build or builds[-1]
    print(f"[错误] 未知加载器 {loader}"); sys.exit(1)

def installer_url(loader, mc, ver):
    if loader == "fabric":
        return DATA["fabric"]["installers"][0]["url"]
    if loader == "quilt":
        return DATA["quilt"]["installers"][0]["url"]
    if loader == "forge":
        full = f"{mc}-{ver}"
        return f"https://files.minecraftforge.net/maven/net/minecraftforge/forge/{full}/forge-{full}-installer.jar"
    if loader == "neoforge":
        if mc in DATA["neoforge"]["legacy_1_20_1"]:
            full = f"{mc}-{ver}"
            return f"https://maven.neoforged.net/releases/net/neoforged/forge/{full}/forge-{full}-installer.jar"
        return f"https://maven.neoforged.net/releases/net/neoforged/neoforge/{ver}/neoforge-{ver}-installer.jar"

def cmd_list(loader, mc=None):
    if loader in ("fabric", "quilt"):
        games = DATA[loader]["games"]
        items = sorted(games.items(), reverse=True)
        if mc:
            if mc not in games: print(f"[错误] 不支持 {mc}"); sys.exit(1)
            items = [(mc, games[mc])]
        for g, d in items:
            print(f"{g:<22} stable={d['stable'] or '-':<16} beta={d['beta'] or '-':<16} ({len(d['loaders'])} loaders)")
    else:
        builds = DATA[loader]["builds"] if loader == "forge" else {**DATA["neoforge"]["builds"], **DATA["neoforge"]["legacy_1_20_1"]}
        keys = [k for k in builds if not mc or k == mc]
        for k in sorted(keys, reverse=True):
            print(f"{k:<22} {len(builds[k])} builds, latest={builds[k][-1]}")

def main():
    ap = argparse.ArgumentParser(description="MC 模组加载器安装工具")
    ap.add_argument("loader", choices=["fabric", "quilt", "forge", "neoforge"])
    ap.add_argument("mc", nargs="?", help="MC 版本")
    ap.add_argument("--build", help="指定加载器构建版本")
    ap.add_argument("--dir", default=".", help="安装目标目录（默认当前目录）")
    ap.add_argument("--java", default="java", help="java 可执行文件路径")
    ap.add_argument("--list", action="store_true", help="列出版本而不安装")
    args = ap.parse_args()

    if args.list or not args.mc:
        if not args.mc: print("[提示] 未指定 MC 版本，列出全部")
        cmd_list(args.loader, args.mc); return

    mc, loader = args.mc, args.loader
    ver = pick_loader(loader, mc, args.build)
    url = installer_url(loader, mc, ver)
    side = "server" if SERVER else "client"
    print(f"[信息] {loader} | MC {mc} | loader {ver}")
    print(f"[信息] 安装包: {url}")
    tmp = tempfile.mkdtemp(prefix="mcloader-")
    jar = os.path.join(tmp, os.path.basename(url))
    print(f"[下载] -> {jar}")
    http_get(url, jar)
    print(f"[完成] 安装包大小 {human(os.path.getsize(jar))}")

    target = os.path.abspath(args.dir)
    os.makedirs(target, exist_ok=True)
    if loader in ("fabric", "quilt"):
        cmd = [args.java, "-jar", jar, side, "-mcversion", mc, "-loader", ver, "-dir", target]
        if side == "server": cmd.append("-downloadMaven")
    else:
        cmd = [args.java, "-jar", jar, f"--install{'Server' if side == 'server' else 'Client'}", target]
    print(f"[执行] {' '.join(cmd)}")
    r = subprocess.run(cmd)
    sys.exit(r.returncode)

if __name__ == "__main__":
    main()
