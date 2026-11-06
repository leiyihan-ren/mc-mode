#!/usr/bin/env bash
# MC-Next 原生 APK 完整构建链路（真实可复现）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] 拉取真实 JRE17 / GL4ES / LWJGL 运行时资产"
python3.11 tools/fetch-runtime.py "$@"

echo "==> [2/4] JVM 层单元测试（36 个纯 Java 用例）"
./gradlew testDebugUnitTest --no-daemon --console=plain

echo "==> [3/4] NDK r27c + CMake 3.22.1 交叉编译 JNI，并打包 APK"
./gradlew assembleDebug --no-daemon --console=plain

echo "==> [4/4] 输出交付物"
OUT=/workspace/MC-Next-Native-0.2.0.apk
cp app/build/outputs/apk/debug/app-debug.apk "$OUT"
ls -la "$OUT"
python3.11 - <<'PY'
import zipfile
p='/workspace/MC-Next-Native-0.2.0.apk'
z=zipfile.ZipFile(p); n=z.namelist()
so=[x for x in n if x.startswith('lib/arm64-v8a/') and x.endswith('.so')]
data=[x for x in n if x.startswith('assets/runtime/')]
assert any('libjvm.so' in x for x in so), '缺少 libjvm.so'
assert any('libgl4es_114.so' in x for x in so), '缺少 GL4ES'
assert any('libmcnext_jni.so' in x for x in so), '缺少 JNI 桥'
assert any(x.endswith('lib/modules') for x in data), '缺少 JRE modules'
print(f'校验通过: {len(so)} 个 .so, {len(data)} 个运行时数据文件')
PY
