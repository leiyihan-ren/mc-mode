#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minecraft Java 版客户端下载工具 —— 数据来自 Mojang 官方清单，自动校验 SHA1。

用法：
  python3 download.py <版本号> [更多版本号...]   下载指定版本客户端
  python3 download.py --era alpha               下载某一时代全部版本
  python3 download.py --list [--era release]    列出可用版本
示例：
  python3 download.py 1.21.11
  python3 download.py c0.30_01c b1.7.3 1.0
"""
import argparse, hashlib, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIND, SUFFIX = "client", "client.jar"

def load():
    with open(os.path.join(ROOT, "versions.json"), encoding="utf-8") as f:
        return json.load(f)

def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024: return f"{f:.1f}{u}"
        f /= 1024
    return f"{f:.1f}TB"

def sha1_of(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def download(rec, outdir):
    info = rec.get(KIND)
    if not info:
        print(f"[跳过] {rec['id']}：Mojang 未提供官方客户端")
        return False
    dest = os.path.join(outdir, f"{rec['id']}-{SUFFIX}")
    if os.path.exists(dest) and sha1_of(dest) == info["sha1"]:
        print(f"[已存在] {dest}")
        return True
    print(f"[下载] {rec['id']} ({human(info['size'])}) -> {dest}")
    req = urllib.request.Request(info["url"], headers={"User-Agent": "mc-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk: break
            f.write(chunk)
    ok = sha1_of(dest) == info["sha1"]
    print(f"[{'校验通过' if ok else '校验失败'}] SHA1={info['sha1']}")
    return ok

def main():
    ap = argparse.ArgumentParser(description="Minecraft Java 版客户端下载工具")
    ap.add_argument("ids", nargs="*", help="版本号，可多个")
    ap.add_argument("--era", help="按时代批量下载：pre-classic/classic/indev/infdev/alpha/beta/release/snapshot")
    ap.add_argument("--out", default=".", help="输出目录（默认当前目录）")
    ap.add_argument("--list", action="store_true", help="列出版本而不下载")
    args = ap.parse_args()
    recs = load()
    sel = []
    if args.list:
        sel = [r for r in recs if not args.era or r["era"] == args.era]
        for r in sel:
            mark = "OK" if "client" in r else "--"
            print(f"{mark}  {r['id']:<24} {r['releaseTime'][:10]}  {r['era']}")
        print(f"共 {len(sel)} 个版本")
        return
    if args.era:
        sel = [r for r in recs if r["era"] == args.era]
    for vid in args.ids:
        hit = [r for r in recs if r["id"] == vid]
        if not hit:
            print(f"[警告] 未找到版本：{vid}")
        sel.append(hit[0] if hit else None)
    sel = [r for r in sel if r]
    if not sel:
        ap.print_help(); return
    total = sum(r.get("client", {}).get("size", 0) for r in sel)
    print(f"即将下载 {len(sel)} 个版本，共约 {human(total)}，保存到 {os.path.abspath(args.out)}")
    if input("确认？(y/N) ").strip().lower() != "y":
        print("已取消"); return
    os.makedirs(args.out, exist_ok=True)
    fail = [r["id"] for r in sel if not download(r, args.out)]
    if fail:
        print(f"完成，{len(fail)} 个失败：{fail}")
        sys.exit(1)
    print("全部完成")

if __name__ == "__main__":
    main()
