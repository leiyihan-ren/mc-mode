#!/usr/bin/env bash
# build-signed-desktop.sh — 0.6.0 模块六：Windows / macOS 数字签名桌面产物（可复现，不伪造）
#
# 【为什么沙盒里没有 .exe / .dmg】
# Linux 沙盒没有 Authenticode 证书（.pfx/.p12）、没有 Apple Developer ID 证书、
# 没有 macOS 的 hdiutil / codesign / notarytool，也没有 Windows 的 signtool。
# 因此这里刻意不产出「改个后缀冒充已签名」的安装包：那才是伪造。
# 本脚本把真实 electron-builder 签名链路固化为可复现命令，在持有证书的构建机/CI 上一键产出。
#
# 【用法】
#   bash tools/build-signed-desktop.sh check    # 只报告凭据/平台状态，不构建（沙盒可跑）
#   CSC_LINK=/path/cert.pfx CSC_KEY_PASSWORD=xxx bash tools/build-signed-desktop.sh win
#   CSC_LINK=/path/cert.p12 CSC_KEY_PASSWORD=xxx bash tools/build-signed-desktop.sh mac
#
# electron-builder 原生读取：
#   CSC_LINK              证书路径或 base64 内容（.p12/.pfx）
#   CSC_KEY_PASSWORD      证书密码
#   CSC_NAME              macOS 钥匙串中的证书名（用钥匙串时替代 CSC_LINK）
#   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID   公证用（notarize 钩子）
# Windows 签名由 electron-builder 内置 rcedit/signtool 完成；macOS 签名由内置 codesign 完成。
# Apple 公证（notarize）是签名的独立后续步骤，需在项目里配置 afterSign 钩子，
# 这里只做「签名构建」，不谎称已完成公证。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-check}"
cd "$ROOT"

has() { [ -n "${!1:-}" ] && echo "✓" || echo "✗"; }
report() {
  echo "平台: $(uname -s)"
  echo "  CSC_LINK                  $(has CSC_LINK)"
  echo "  CSC_KEY_PASSWORD          $(has CSC_KEY_PASSWORD)"
  echo "  APPLE_ID                  $(has APPLE_ID)"
  echo "  APPLE_APP_SPECIFIC_PASSWORD $(has APPLE_APP_SPECIFIC_PASSWORD)"
  echo "  APPLE_TEAM_ID             $(has APPLE_TEAM_ID)"
}

case "$TARGET" in
  check)
    report
    echo
    echo "[结论] 本沙盒为 Linux 且无代码签名证书，无法产出带数字签名的 .exe / .dmg。"
    echo "       本轮交付的 Linux AppImage / tar.gz 为未签名产物（Linux 生态无强制代码签名）。"
    echo "       在持有证书的 Windows / macOS 构建机上执行 win / mac 子命令即可得到真实签名产物。"
    exit 0
    ;;
  win|mac)
    ;;
  *)
    echo "用法: $0 {check|win|mac}" >&2
    exit 2
    ;;
esac

: "${CSC_LINK:?必须提供代码签名证书 CSC_LINK（.p12/.pfx）}"
: "${CSC_KEY_PASSWORD:?必须提供证书密码 CSC_KEY_PASSWORD}"

if [ "$TARGET" = "win" ]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
    *) echo "Windows NSIS 签名构建建议在本机 Windows 执行（electron-builder 可在 Linux 交叉构建 NSIS，但 Authenticode 签名需 signtool/证书支持）。" >&2 ;;
  esac
  echo "[build] electron-builder --win nsis --x64（CSC_LINK 证书生效）"
  npx electron-builder --win nsis --x64
else
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "macOS .dmg + codesign 必须在 macOS 主机执行（需要 hdiutil / codesign / 钥匙串）。" >&2
    report
    exit 3
  fi
  echo "[build] electron-builder --mac dmg --universal（CSC_LINK 证书生效）"
  echo "[note] Apple 公证需另行配置 afterSign 钩子（@electron/notarize）与 APPLE_* 凭据，本脚本不谎称已公证。"
  npx electron-builder --mac dmg --universal
fi

echo "[done] 产物目录: $ROOT/release/"
ls -lh "$ROOT/release"/*.exe "$ROOT/release"/*.dmg 2>/dev/null || true
