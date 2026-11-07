#!/usr/bin/env bash
# build-unified-apk.sh — 0.6.0 模块一：两端 UI 大一统 APK 构建
#
# 废弃「简单 WebView 壳」：同一个 Capacitor APK 内同时包含
#   1. 桌面端完整 React UI（vite dist/ → www/ → assets/public）
#   2. 真实 JRE 17 / GL4ES / libjvm.so（54 个 .so + assets/runtime）
#   3. 本轮新写的 JNI 指令桥（bridge_commands.c + 原有 jvm_launcher.c / input_bridge.c）
#   4. McNextBridge Capacitor 插件（window.mcnext → NativeCommandRouter → JNI 或 PC /api/rpc）
#
# 全程使用真实文件与真实编译，不做任何「复制旧 APK 改个名」的假动作。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAP="$ROOT/android-build"
SRC="$ROOT/android/app/src/main"
BRIDGE="$ROOT/android/bridge"
OUT="${1:-/workspace/MC-Next-Unified-0.6.0.apk}"
# debug（默认，沿用已验证链路）| release（正式版：真实 keystore 签名 + apksigner 验签）
BUILD_TYPE="${MCNEXT_BUILD_TYPE:-debug}"
case "$BUILD_TYPE" in
  debug|release) ;;
  *) echo "MCNEXT_BUILD_TYPE 只能是 debug 或 release" >&2; exit 1 ;;
esac

export JAVA_HOME="${JAVA_HOME:-$(ls -d /root/.sdkman/candidates/java/current)}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

echo "[0/9] 版本与契约自检"
node "$ROOT/tools/gen-bridge-contract.cjs"
VERSION=$(node -p "require('$ROOT/package.json').version")
echo "  version=$VERSION  buildType=$BUILD_TYPE"

echo "[1/9] 构建桌面渲染层（同一份 React UI）"
(cd "$ROOT" && npm run build:renderer)
BUNDLE=$(basename "$(ls "$ROOT/dist/assets/"index-*.js | head -1)")
echo "  bundle=$BUNDLE"

echo "[2/9] 同步渲染产物 → Capacitor www/"
rm -rf "$CAP/www" && mkdir -p "$CAP/www"
cp -r "$ROOT/dist/." "$CAP/www/"

echo "[3/9] 同步 Java 桥接层 + 原生引擎类（排除旧 SurfaceView-only Activity）"
JAVA_DST="$CAP/android/app/src/main/java/com/mcnext/launcher"
mkdir -p "$JAVA_DST"
cp -f "$BRIDGE/java/com/mcnext/launcher/"*.java "$JAVA_DST/"
for f in "$SRC/java/com/mcnext/launcher/"*.java; do
  b=$(basename "$f")
  [ "$b" = "MainActivity.java" ] && continue   # 大一统 Activity 已由 bridge 覆盖
  cp -f "$f" "$JAVA_DST/"
done
mkdir -p "$JAVA_DST/input"
cp -f "$SRC/java/com/mcnext/launcher/input/"*.java "$JAVA_DST/input/"
echo "  java files: $(find "$JAVA_DST" -name '*.java' | wc -l)"

echo "[4/9] 同步 JNI C 源码与 CMake（libmcnext_jni.so 由本轮源码编译，不复用旧 .so）"
JNI_DST="$CAP/android/app/src/main/jni"
rm -rf "$JNI_DST" && mkdir -p "$JNI_DST"
cp -f "$SRC/jni/jvm_launcher.c" "$SRC/jni/input_bridge.c" "$SRC/jni/mcnext_jni.h" "$JNI_DST/"
cp -f "$BRIDGE/jni/bridge_commands.c" "$BRIDGE/jni/CMakeLists.txt" "$JNI_DST/"

echo "[5/9] 同步真实 JRE / GL4ES 二进制 + Release 配置"
LIB_DST="$CAP/android/app/src/main/jniLibs"
rm -rf "$LIB_DST" && mkdir -p "$LIB_DST"
cp -r "$SRC/jniLibs/." "$LIB_DST/"
# libmcnext_jni.so 交给 CMake 用本轮 bridge_commands.c 重新编译，避免与旧 so 冲突
find "$LIB_DST" -name 'libmcnext_jni.so' -delete
ASSET_DST="$CAP/android/app/src/main/assets"
mkdir -p "$ASSET_DST/runtime"
rm -rf "$ASSET_DST/runtime"
cp -r "$SRC/assets/runtime" "$ASSET_DST/runtime"
cp -f "$ROOT/config/release.json" "$ASSET_DST/release.json"
echo "  .so count: $(find "$LIB_DST" -name '*.so' | wc -l)"

echo "[6/9] 注入 CMake externalNativeBuild（幂等）"
python3.11 - "$CAP/android/app/build.gradle" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
changed = False
if 'externalNativeBuild' not in s:
    s = s.replace('android {\n',
        'android {\n    externalNativeBuild {\n        cmake { path "src/main/jni/CMakeLists.txt" }\n    }\n', 1)
    changed = True
# JRE / GL4ES 二进制只有 arm64-v8a，限制 CMake 只为同一 ABI 产出 libmcnext_jni.so
if 'abiFilters' not in s:
    s = s.replace('defaultConfig {\n',
        "defaultConfig {\n        ndk { abiFilters 'arm64-v8a' }\n", 1)
    changed = True
if changed:
    p.write_text(s)
    print('  injected externalNativeBuild + arm64 abiFilters')
else:
    print('  gradle config already patched')
PY

echo "[7/9] cap sync android（再降 Java 21 → 17，规避 JDK 20 的 invalid source release）"
(cd "$CAP" && node_modules/.bin/cap sync android)
sed -i 's/JavaVersion.VERSION_21/JavaVersion.VERSION_17/g' \
  "$CAP/android/app/capacitor.build.gradle" \
  "$CAP/android/capacitor-cordova-android-plugins/build.gradle"

echo "[7.5/9] 版本号归一：package.json → versionName / versionCode（消除 1.0 占位）"
python3.11 - "$CAP/android/app/build.gradle" "$VERSION" <<'PY'
import sys, re
from pathlib import Path
p = Path(sys.argv[1]); version = sys.argv[2]
s = p.read_text()
nums = [int(x) for x in re.findall(r'\d+', version)[:3]]
nums += [0] * (3 - len(nums))
vc = nums[0] * 10000 + nums[1] * 100 + nums[2]
s = re.sub(r'versionCode\s+\d+', 'versionCode %d' % vc, s, count=1)
s = re.sub(r'versionName\s+"[^"]*"', 'versionName "%s"' % version, s, count=1)
p.write_text(s)
print('  versionName=%s versionCode=%d' % (version, vc))
PY

if [ "$BUILD_TYPE" = "release" ]; then
echo "[7.6/9] 正式版签名准备：真实 keystore + gradle signingConfig"
KS="${MCNEXT_KEYSTORE:-/workspace/.mcnext-release.keystore}"
export MCNEXT_KEYSTORE="$KS"
export MCNEXT_KEY_ALIAS="${MCNEXT_KEY_ALIAS:-mcnext}"
export MCNEXT_KEYSTORE_PASSWORD="${MCNEXT_KEYSTORE_PASSWORD:-mcnext-release-demo-2026}"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -alias "$MCNEXT_KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10950 \
    -storetype PKCS12 -keystore "$KS" \
    -storepass "$MCNEXT_KEYSTORE_PASSWORD" -keypass "$MCNEXT_KEYSTORE_PASSWORD" \
    -dname "CN=MC-Next Release, OU=MC-Next, O=MC-Next, L=Shenzhen, ST=Guangdong, C=CN"
  echo "  已生成真实自签名证书（生产请替换自有证书并保密）: $KS"
fi
python3.11 - "$CAP/android/app/build.gradle" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
if 'mcnextRelease' not in s:
    s = s.replace('android {\n',
        'android {\n'
        '    signingConfigs {\n'
        '        mcnextRelease {\n'
        '            storeFile file(System.getenv("MCNEXT_KEYSTORE"))\n'
        '            storePassword System.getenv("MCNEXT_KEYSTORE_PASSWORD")\n'
        '            keyAlias System.getenv("MCNEXT_KEY_ALIAS")\n'
        '            keyPassword System.getenv("MCNEXT_KEYSTORE_PASSWORD")\n'
        '        }\n'
        '    }\n', 1)
    s = s.replace('        release {\n',
        '        release {\n            signingConfig signingConfigs.mcnextRelease\n', 1)
    p.write_text(s)
    print('  injected signingConfigs.mcnextRelease into buildTypes.release')
else:
    print('  signingConfig already patched')
PY
fi

TASK=assembleDebug
[ "$BUILD_TYPE" = "release" ] && TASK=assembleRelease
echo "[8/9] gradlew $TASK（真实编译 JNI + Capacitor 插件 + 打包）"
(cd "$CAP/android" && ./gradlew "$TASK" --no-daemon --console=plain)
APK=$(ls "$CAP/android/app/build/outputs/apk/$BUILD_TYPE/"*.apk 2>/dev/null | head -1)
[ -n "$APK" ] && [ -f "$APK" ] || { echo "构建失败：未找到 $BUILD_TYPE APK" >&2; exit 1; }
echo "  apk=$APK"

echo "[9/9] 产物级校验：本轮 bundle / JRE / JNI 桥必须同时在 APK 内"
python3.11 - "$APK" "$BUNDLE" <<'PY'
import sys, zipfile
apk, bundle = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk) as z:
    names = set(z.namelist())
checks = {
    '本轮 React bundle': f'assets/public/assets/{bundle}',
    'index.html':        'assets/public/index.html',
    'JRE libjvm.so':     'lib/arm64-v8a/libjvm.so',
    'GL4ES 渲染库':       'lib/arm64-v8a/libgl4es_114.so',
    'JNI 指令桥 so':      'lib/arm64-v8a/libmcnext_jni.so',
    'Release 配置':       'assets/release.json',
    'JRE 运行时模块':      'assets/runtime/lib/modules',
}
bad = []
for label, path in checks.items():
    ok = path in names
    print(f'  {"OK " if ok else "MISS"} {label}: {path}')
    if not ok: bad.append(path)
so = [n for n in names if n.startswith('lib/arm64-v8a/') and n.endswith('.so')]
print(f'  arm64 .so 总数: {len(so)}')
if bad:
    print('校验失败：缺少上述文件', file=sys.stderr)
    sys.exit(1)
PY

if [ "$BUILD_TYPE" = "release" ]; then
echo "[9.5/9] apksigner 真实验签（v1/v2/v3 方案 + 证书指纹）"
APKSIGNER=$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
[ -x "$APKSIGNER" ] || { echo "未找到 apksigner，无法证明签名有效" >&2; exit 1; }
"$APKSIGNER" verify --verbose --print-certs "$APK" | head -14
fi

cp -f "$APK" "$OUT"
echo "[done] $OUT"
echo "  size: $(du -h "$OUT" | cut -f1)"
echo "  sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
