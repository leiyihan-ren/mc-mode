cmake_minimum_required(VERSION 3.22.1)
project("mcnext_jni" C)

# JNI 桥：JVM 启动 + 触控/手柄输入透传
add_library(
        mcnext_jni
        SHARED
        jvm_launcher.c
        input_bridge.c
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
