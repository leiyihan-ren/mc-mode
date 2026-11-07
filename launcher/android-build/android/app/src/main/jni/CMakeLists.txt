cmake_minimum_required(VERSION 3.22.1)
project("mcnext_jni" C)

# 0.6.0 大一统：JVM 启动 + 触控/手柄输入 + UI 指令桥，统一编译成 libmcnext_jni.so
# 由 tools/build-unified-apk.sh 连同源文件一起同步进 Capacitor 原生工程。
add_library(
        mcnext_jni
        SHARED
        jvm_launcher.c
        input_bridge.c
        bridge_commands.c
)

target_include_directories(mcnext_jni PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(
        mcnext_jni
        ${log-lib}
        ${android-lib}
        dl
)

target_compile_options(mcnext_jni PRIVATE -Wall -Wextra -Wno-unused-parameter)
