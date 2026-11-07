#!/usr/bin/env bash
# build-capacitor.sh — Capacitor WebView 壳构建（桌面渲染层同步 + Java 版本兼容修复）
#
# 关键坑（实测）：Capacitor 8 的 `cap sync android` 每次都会把
#   android/app/capacitor.build.gradle
#   android/capacitor-cordova-android-plugins/build.gradle
# 重新生成为 JavaVersion.VERSION_21。而本机/CI 的 JDK 是 20，
# 编译会报 `error: invalid source release: 21`。因此 sync 之后必须重新降到 VERSION_17。
# 本脚本把该修复固化，保证「Electron + Capacitor 构建流程畅通」可重复执行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export JAVA_HOME="${JAVA_HOME:-$(ls -d /root/.sdkman/candidates/java/current)}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

echo "[1/4] 同步最新 Vite 渲染产物 → www/"
rm -rf www/*
cp -r "$ROOT/../dist/." www/
echo "  bundle: $(ls www/assets/*.js | xargs -n1 basename)"

echo "[2/4] cap sync android"
node_modules/.bin/cap sync android

echo "[3/4] 修复被 cap sync 覆盖的 Java 版本（21 → 17）"
sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' \
  android/app/capacitor.build.gradle \
  android/capacitor-cordova-android-plugins/build.gradle
grep -h "sourceCompatibility" android/app/capacitor.build.gradle

echo "[4/4] gradlew assembleDebug"
cd android
./gradlew assembleDebug --no-daemon --console=plain

echo "[done] $(ls -lh app/build/outputs/apk/debug/app-debug.apk)"
