/**
 * jvm_launcher.c — JNI 层：在 Android 进程内真实创建 JVM 并把启动参数传递给 Minecraft
 *
 * 与 PojavLauncher / Zalith Launcher 同构的底层路径：
 *  1. dlopen(<nativeLibraryDir>/libjvm.so)（由 JRE 移植包提供）
 *  2. dlsym("JNI_CreateJavaVM") → 构造 JavaVMOption[]（-Djava.library.path / -cp / -Xmx ...）
 *  3. JNI_CreateJavaVM 得到 JNIEnv，FindClass(mainClass) + GetStaticMethodID("main","([Ljava/lang/String;)V")
 *  4. NewObjectArray 传入 --gameDir / --assetsDir / --version / --accessToken 等真实 MC 参数
 *  5. CallStaticVoidMethod 启动游戏主线程，异常用 ExceptionDescribe 回传 logcat
 *
 * 说明：Pojav 系也可用 libjli.so 的 JLI_Launch 启动（能复用 JVM 自带参数解析）；
 * 本实现选标准的 JNI_CreateJavaVM 路径，便于在任意 JRE 移植包上工作，二者语义等价。
 * 渲染 surface 通过 ANativeWindow_fromSurface 保存，供 GL4ES / ANGLE / VirGL 创建 EGL 窗口。
 */
#include "mcnext_jni.h"
#include <android/log.h>
#include <android/native_window_jni.h>
#include <dlfcn.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define LOG_TAG "mcnext-jni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

JavaVM *g_mcnext_vm = NULL;
pthread_mutex_t g_mcnext_lock = PTHREAD_MUTEX_INITIALIZER;
char g_mcnext_error[1024] = {0};
static ANativeWindow *g_window = NULL;
static int g_exit_code = -9999;

typedef jint(JNICALL *CreateJavaVM_t)(JavaVM **, void **, void *);

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

JNIEXPORT jint JNICALL
Java_com_mcnext_launcher_JvmBridge_startJvm(JNIEnv *env, jclass clazz,
                                             jobjectArray vmOptions,
                                             jstring mainClass,
                                             jobjectArray appArgs,
                                             jstring runtimeLibDir) {
    (void)clazz;
    g_mcnext_error[0] = '\0';
    const char *libdir = (*env)->GetStringUTFChars(env, runtimeLibDir, NULL);
    char libpath[PATH_MAX];
    snprintf(libpath, sizeof(libpath), "%s/libjvm.so", libdir ? libdir : "");
    LOGI("启动 JVM: %s", libpath);

    void *handle = dlopen(libpath, RTLD_NOW | RTLD_GLOBAL);
    if (!handle) {
        snprintf(g_mcnext_error, sizeof(g_mcnext_error),
                 "dlopen(%s) 失败: %s —— 请通过 runtime/fetch-runtime.sh 安装 JRE 移植包",
                 libpath, dlerror() ? dlerror() : "unknown");
        LOGE("%s", g_mcnext_error);
        if (libdir) (*env)->ReleaseStringUTFChars(env, runtimeLibDir, libdir);
        return -100;
    }
    CreateJavaVM_t create = (CreateJavaVM_t)dlsym(handle, "JNI_CreateJavaVM");
    if (!create) {
        snprintf(g_mcnext_error, sizeof(g_mcnext_error),
                 "libjvm.so 中找不到 JNI_CreateJavaVM: %s", dlerror() ? dlerror() : "unknown");
        LOGE("%s", g_mcnext_error);
        return -101;
    }

    /* 1. 把 Java 侧构造好的 -D / -cp / -Xmx 参数转成 JavaVMOption[] */
    jsize optc = (*env)->GetArrayLength(env, vmOptions);
    JavaVMOption *opts = (JavaVMOption *)calloc((size_t)optc + 1, sizeof(JavaVMOption));
    const char **utf = (const char **)calloc((size_t)optc + 1, sizeof(char *));
    /* 保留每个 jstring 的局部引用：ReleaseStringUTFChars 必须与 GetStringUTFChars 用同一对象 */
    jobject *refs = (jobject *)calloc((size_t)optc + 1, sizeof(jobject));
    for (jsize i = 0; i < optc; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, vmOptions, i);
        refs[i] = (*env)->NewLocalRef(env, s);
        (*env)->DeleteLocalRef(env, s);
        utf[i] = (*env)->GetStringUTFChars(env, (jstring)refs[i], NULL);
        opts[i].optionString = (char *)utf[i];
        opts[i].extraInfo = NULL;
    }
    /* LWJGL 在 Android 上必须绕过主线程检查；渲染库路径由 RenderBackend 决定 */
    opts[optc].optionString = (char *)"-Dorg.lwjgl.glfw.checkThread0=false";

    JavaVMInitArgs vm_args;
    /* Android NDK 的 jni.h 最高只定义 JNI_VERSION_1_6；JRE 8/17/21 均向下兼容此版本 */
    vm_args.version = JNI_VERSION_1_6;
    vm_args.nOptions = optc + 1;
    vm_args.options = opts;
    vm_args.ignoreUnrecognized = JNI_FALSE;

    JNIEnv *vmEnv = NULL;
    jint rc = create(&g_mcnext_vm, (void **)&vmEnv, &vm_args);
    LOGI("JNI_CreateJavaVM 返回 %d", rc);
    if (rc != JNI_OK || !vmEnv) {
        snprintf(g_mcnext_error, sizeof(g_mcnext_error), "JNI_CreateJavaVM 失败 (rc=%d)", rc);
        LOGE("%s", g_mcnext_error);
        g_exit_code = -102;
        goto cleanup_opts;
    }

    /* 2. 找 main 类并传入真实 MC 启动参数 */
    const char *mc = (*env)->GetStringUTFChars(env, mainClass, NULL);
    char *slash = strdup(mc ? mc : "net.minecraft.client.main.Main");
    for (char *p = slash; *p; p++) if (*p == '.') *p = '/';
    jclass mainCls = (*vmEnv)->FindClass(vmEnv, slash);
    if (!mainCls) {
        snprintf(g_mcnext_error, sizeof(g_mcnext_error), "FindClass(%s) 失败：classpath 缺少游戏 Jar", slash);
        LOGE("%s", g_mcnext_error);
        free(slash);
        rc = -200;
        goto cleanup_vm;
    }
    jmethodID mainMid = (*vmEnv)->GetStaticMethodID(vmEnv, mainCls, "main", "([Ljava/lang/String;)V");
    if (!mainMid) {
        snprintf(g_mcnext_error, sizeof(g_mcnext_error), "找不到静态 main(String[]) 方法");
        LOGE("%s", g_mcnext_error);
        free(slash);
        rc = -201;
        goto cleanup_vm;
    }

    jclass strCls = (*vmEnv)->FindClass(vmEnv, "java/lang/String");
    jsize argc = (*env)->GetArrayLength(env, appArgs);
    jobjectArray argv = (*vmEnv)->NewObjectArray(vmEnv, argc, strCls, NULL);
    for (jsize i = 0; i < argc; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, appArgs, i);
        const char *c = (*env)->GetStringUTFChars(env, s, NULL);
        (*vmEnv)->SetObjectArrayElement(vmEnv, argv, i, (*vmEnv)->NewStringUTF(vmEnv, c));
        (*env)->ReleaseStringUTFChars(env, s, c);
        (*env)->DeleteLocalRef(env, s);
    }
    LOGI("调用 %s.main(%d 个参数)", slash, argc);
    (*vmEnv)->CallStaticVoidMethod(vmEnv, mainCls, mainMid, argv);
    if ((*vmEnv)->ExceptionCheck(vmEnv)) {
        LOGE("游戏主线程抛出异常：");
        (*vmEnv)->ExceptionDescribe(vmEnv);
        (*vmEnv)->ExceptionClear(vmEnv);
        snprintf(g_mcnext_error, sizeof(g_mcnext_error),
                 "游戏主线程抛出异常（详见 logcat / 崩溃分析模块）");
        rc = -202;
    } else {
        rc = 0;
    }
    free(slash);

cleanup_vm:
    if (g_mcnext_vm) {
        (*g_mcnext_vm)->DestroyJavaVM(g_mcnext_vm);
        g_mcnext_vm = NULL;
    }
cleanup_opts:
    for (jsize i = 0; i < optc; i++) {
        if (refs[i]) {
            if (utf[i]) (*env)->ReleaseStringUTFChars(env, (jstring)refs[i], utf[i]);
            (*env)->DeleteLocalRef(env, refs[i]);
        }
    }
    free(refs);
    free(opts);
    free(utf);
    if (libdir) (*env)->ReleaseStringUTFChars(env, runtimeLibDir, libdir);
    g_exit_code = rc;
    return rc;
}

JNIEXPORT void JNICALL
Java_com_mcnext_launcher_JvmBridge_setSurface(JNIEnv *env, jclass clazz, jobject surface) {
    (void)clazz;
    pthread_mutex_lock(&g_mcnext_lock);
    if (g_window) { ANativeWindow_release(g_window); g_window = NULL; }
    if (surface) g_window = ANativeWindow_fromSurface(env, surface);
    LOGI("渲染 Surface %s", g_window ? "已绑定" : "已释放");
    pthread_mutex_unlock(&g_mcnext_lock);
}

JNIEXPORT jlong JNICALL
Java_com_mcnext_launcher_JvmBridge_getNativeWindowPtr(JNIEnv *env, jclass clazz) {
    (void)env; (void)clazz;
    pthread_mutex_lock(&g_mcnext_lock);
    jlong p = (jlong)(intptr_t)g_window;
    pthread_mutex_unlock(&g_mcnext_lock);
    return p;
}

JNIEXPORT jstring JNICALL
Java_com_mcnext_launcher_JvmBridge_lastError(JNIEnv *env, jclass clazz) {
    (void)clazz;
    return (*env)->NewStringUTF(env, g_mcnext_error[0] ? g_mcnext_error : "");
}

JNIEXPORT jint JNICALL
Java_com_mcnext_launcher_JvmBridge_jvmStatus(JNIEnv *env, jclass clazz) {
    (void)env; (void)clazz;
    return g_mcnext_vm ? 1 : (g_exit_code == -9999 ? 0 : 2);
}

JNIEXPORT jlong JNICALL
Java_com_mcnext_launcher_JvmBridge_uptimeMs(JNIEnv *env, jclass clazz) {
    (void)env; (void)clazz;
    return (jlong)now_ms();
}

/**
 * 渲染后端环境变量注入：GL4ES / ANGLE / VirGL / Zink 的 .so 在进程启动时
 * 读取 POJAV_RENDERER、MESA_LOADER_DRIVER_OVERRIDE、TU_DEBUG 等变量，
 * 必须在 JNI_CreateJavaVM 之前 setenv 才生效（之后 LWJGL 会 dlopen 这些库）。
 */
JNIEXPORT void JNICALL
Java_com_mcnext_launcher_JvmBridge_applyRenderEnv(JNIEnv *env, jclass clazz, jobjectArray kv) {
    (void)clazz;
    if (!kv) return;
    jsize n = (*env)->GetArrayLength(env, kv);
    for (jsize i = 0; i < n; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, kv, i);
        if (!s) continue;
        const char *raw = (*env)->GetStringUTFChars(env, s, NULL);
        if (raw) {
            char buf[512];
            snprintf(buf, sizeof(buf), "%s", raw);
            char *eq = strchr(buf, '=');
            if (eq) {
                *eq = '\0';
                setenv(buf, eq + 1, 1);
                LOGI("渲染环境 %s=%s", buf, eq + 1);
            }
            (*env)->ReleaseStringUTFChars(env, s, raw);
        }
        (*env)->DeleteLocalRef(env, s);
    }
}
