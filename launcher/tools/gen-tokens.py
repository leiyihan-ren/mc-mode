#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
gen-tokens.py — 从 design/tokens.json 单数据源生成两端视觉规范产物。

  - src/theme.css      : 桌面端 CSS 变量（:root 默认深色，[data-theme=midnight] 夜间护眼）
  - android/app/src/main/res/values/colors.xml : Android 原生端颜色资源（默认深色）
  - android/app/src/main/res/values-night/colors.xml : 夜间护眼（Android -night 资源限定符目录）

颜色同时输出两种形式：
  --mc-accent:    #5b9dff   （给裸 CSS 直接使用，如 background: var(--mc-accent)）
  --mc-accent-rgb: 91 157 255（给 Tailwind 的 rgb(var(--mc-accent-rgb) / <alpha-value>)，
                                这样 bg-accent/15 这类透明度修饰符仍然生效）

桌面与安卓共用同一份色值/圆角/动效定义，避免两端视觉漂移。
用法: python3.11 tools/gen-tokens.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKENS = json.loads((ROOT / "design" / "tokens.json").read_text(encoding="utf8"))


def hex_to_rgb_channels(hexstr):
    h = hexstr.lstrip("#")
    if len(h) == 6:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return f"{r} {g} {b}"
    return None


def css_vars(mapping, indent="  "):
    lines = []
    for k, v in mapping.items():
        css_key = "".join(["-" + c.lower() if c.isupper() else c for c in k]).lstrip("-")
        lines.append(f"{indent}--mc-{css_key}: {v};")
        # 7 位 hex 同时输出 -rgb 通道，供 Tailwind 透明度修饰符使用
        if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            ch = hex_to_rgb_channels(v)
            if ch is not None:
                lines.append(f"{indent}--mc-{css_key}-rgb: {ch};")
    return "\n".join(lines)


def gen_css():
    c, m = TOKENS["color"], TOKENS["midnight"]
    out = [
        "/* 由 tools/gen-tokens.py 从 design/tokens.json 生成，请勿手改 */",
        ":root {",
        css_vars({k: v for k, v in c.items()}),
        css_vars({f"r-{k}": v for k, v in TOKENS["radius"].items()}),
        css_vars({f"t-{k}": v for k, v in TOKENS["motion"].items()}),
        "  color-scheme: dark;",
        "}",
        "",
        "/* 沉浸式夜间护眼模式（暖色温、低蓝光、压低对比） */",
        "[data-theme=\"midnight\"] {",
        css_vars({k: v for k, v in m.items() if k != "note"}),
        "}",
        "",
    ]
    (ROOT / "src" / "theme.css").write_text("\n".join(out), encoding="utf8")


def gen_android(mapping, path):
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!-- 由 tools/gen-tokens.py 从 design/tokens.json 生成 -->',
        "<resources>",
    ]
    for k, v in mapping.items():
        if not isinstance(v, str) or not v.startswith("#") or len(v) != 7:
            continue
        name = "".join(["_" + c.lower() if c.isupper() else c for c in k]).lstrip("_")
        lines.append(f'    <color name="mc_{name}">{v}</color>')
    lines.append("</resources>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf8")


if __name__ == "__main__":
    gen_css()
    res = ROOT / "android" / "app" / "src" / "main" / "res" / "values"
    gen_android(TOKENS["color"], res / "colors.xml")
    # Android 夜间模式资源（values-night）
    gen_android({**TOKENS["color"], **{k: v for k, v in TOKENS["midnight"].items() if k != "note"}},
                ROOT / "android" / "app" / "src" / "main" / "res" / "values-night" / "colors.xml")
    print("generated: src/theme.css, values/colors.xml, values-night/colors.xml")
