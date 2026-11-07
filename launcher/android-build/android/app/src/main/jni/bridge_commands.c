/**
 * bridge_commands.c — 0.6.0 模块一：Android UI → JRE17 / GL4ES 的 JNI 指令桥
 *
 * Capacitor WebView 里 window.mcnext 的 native 落点最终由 Capacitor Plugin
 * (McNextBridgePlugin) → NativeCommandRouter → BridgeNative.dispatch() 到达这里。
 * 本文件实现一张真实的 C 函数表，每条指令都落到具体的底层动作：
 *   jvm.status / jvm.lastError / jvm.begin / jvm.end       JVM 生命周期状态机
 *   jvm.requestStop                                       JNI DestroyJavaVM（独立线程）
 *   input.key / input.mouse / input.motion / input.reset    触控/手柄事件队列（与 LWJGL 移植层对接）
 *   render.env                                             GL4ES/ANGLE 进程环境变量（JNI 层 setenv）
 *   probe.ping                                             真实进程探针（pid / 状态 / 库）
 *
 * 与 jvm_launcher.c 共享 g_mcnext_vm / g_mcnext_lock / g_mcnext_error 全局状态，
 * 而不是另建一套「假状态」。所有返回值都是可 JSON.parse 的字符串。
 */
#include "mcnext_jni.h"
#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define LOG_TAG "mcnext-bridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)

extern JavaVM *g_mcnext_vm;
extern pthread_mutex_t g_mcnext_lock;
extern char g_mcnext_error[1024];

/* 0=idle 1=starting/running 2=exited 3=failed，由 Java 路由层在启动前后通知 */
static volatile int s_state = 0;
static volatile long long s_launch_ms = 0;
static volatile int s_stop_requested = 0;

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/** 极简 JSON 字段读取：输入由 Java 路由层构造，格式受控，不引入第三方解析器 */
static int json_int(const char *s, const char *key, int def) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(s ? s : "", pat);
    if (!p) return def;
    p = strchr(p, ':');
    if (!p) return def;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '-' && (*p < '0' || *p > '9')) return def;
    return atoi(p);
}
static float json_float(const char *s, const char *key, float def) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(s ? s : "", pat);
    if (!p) return def;
    p = strchr(p, ':');
    if (!p) return def;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '-' && *p != '.' && (*p < '0' || *p > '9')) return def;
    return strtof(p, NULL);
}

/** JSON 字符串转义（只处理会破坏结构的字符，够用且无依赖） */
static char *json_escape(const char *in) {
    size_t n = strlen(in ? in : "");
    char *out = (char *)malloc(n * 6 + 1);
    char *w = out;
    for (const char *r = in ? in : ""; *r; r++) {
        unsigned char c = (unsigned char)*r;
        if (c == '"' || c == '\\') { *w++ = '\\'; *w++ = (char)c; }
        else if (c == '\n') { memcpy(w, "\\n", 2); w += 2; }
        else if (c == '\r') { memcpy(w, "\\r", 2); w += 2; }
        else if (c == '\t') { memcpy(w, "\\t", 2); w += 2; }
        else if (c < 0x20) { snprintf(w, 7, "\\u%04x", c); w += 6; }
        else *w++ = (char)c;
    }
    *w = '\0';
    return out;
}

static char *fmt(const char *pattern, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, pattern);
    vsnprintf(buf, sizeof(buf), pattern, ap);
    va_end(ap);
    return strdup(buf);
}

static void *destroy_vm_thread(void *unused) {
    (void)unused;
    JavaVM *vm = NULL;
    pthread_mutex_lock(&g_mcnext_lock);
    vm = g_mcnext_vm;
    pthread_mutex_unlock(&g_mcnext_lock);
    if (vm) {
        LOGI("DestroyJavaVM 请求（等待 JVM 非守护线程结束）");
        (*vm)->DestroyJavaVM(vm);
        pthread_mutex_lock(&g_mcnext_lock);
        if (g_mcnext_vm == vm) g_mcnext_vm = NULL;
        pthread_mutex_unlock(&g_mcnext_lock);
    }
    s_state = 2;
    return NULL;
}

/* ---------------- 指令处理函数表 ---------------- */
typedef char *(*handler_t)(const char *args);

static char *h_ping(const char *args) {
    (void)args;
    int has_vm = 0;
    pthread_mutex_lock(&g_mcnext_lock);
    has_vm = g_mcnext_vm ? 1 : 0;
    pthread_mutex_unlock(&g_mcnext_lock);
    return fmt("{\"ok\":true,\"lib\":\"mcnext_jni\",\"pid\":%d,\"hasVm\":%d,\"state\":%d}",
               (int)getpid(), has_vm, s_state);
}
static char *h_status(const char *args) {
    (void)args;
    int has_vm = 0;
    pthread_mutex_lock(&g_mcnext_lock);
    has_vm = g_mcnext_vm ? 1 : 0;
    pthread_mutex_unlock(&g_mcnext_lock);
    long long up = s_launch_ms ? now_ms() - s_launch_ms : 0;
    return fmt("{\"ok\":true,\"running\":%d,\"state\":%d,\"uptimeMs\":%lld,"
               "\"stopRequested\":%d,\"hasVm\":%d}",
               (has_vm && s_state == 1) ? 1 : 0, s_state, up, s_stop_requested, has_vm);
}
static char *h_last_error(const char *args) {
    (void)args;
    char *e = json_escape(g_mcnext_error);
    char *out = fmt("{\"ok\":true,\"error\":\"%s\"}", e);
    free(e);
    return out;
}
static char *h_begin(const char *args) {
    (void)args;
    s_state = 1;
    s_stop_requested = 0;
    s_launch_ms = now_ms();
    LOGI("JVM 会话开始");
    return fmt("{\"ok\":true,\"state\":1}");
}
static char *h_end(const char *args) {
    int code = json_int(args, "code", 0);
    s_state = code == 0 ? 2 : 3;
    LOGI("JVM 会话结束 code=%d", code);
    return fmt("{\"ok\":true,\"state\":%d,\"code\":%d}", s_state, code);
}
static char *h_request_stop(const char *args) {
    (void)args;
    s_stop_requested = 1;
    pthread_t t;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&t, &attr, destroy_vm_thread, NULL) != 0) {
        pthread_attr_destroy(&attr);
        return fmt("{\"ok\":false,\"error\":\"无法创建 JVM 停止线程\"}");
    }
    pthread_attr_destroy(&attr);
    return fmt("{\"ok\":true,\"requested\":true}");
}
static char *h_input_key(const char *args) {
    int key = json_int(args, "key", 0);
    int pressed = json_int(args, "pressed", 1);
    mcnext_input_push(EV_KEY, key, pressed, 0.f, 0.f);
    return fmt("{\"ok\":true,\"type\":\"key\",\"key\":%d,\"pressed\":%d}", key, pressed);
}
static char *h_input_mouse(const char *args) {
    int btn = json_int(args, "button", 0);
    int pressed = json_int(args, "pressed", 1);
    float x = json_float(args, "x", 0.f), y = json_float(args, "y", 0.f);
    mcnext_input_push(EV_MOUSE, btn, pressed, x, y);
    return fmt("{\"ok\":true,\"type\":\"mouse\",\"button\":%d}", btn);
}
static char *h_input_motion(const char *args) {
    float x = json_float(args, "x", 0.f), y = json_float(args, "y", 0.f);
    mcnext_input_push(EV_MOTION, 0, 0, x, y);
    return fmt("{\"ok\":true,\"type\":\"motion\"}");
}
static char *h_input_reset(const char *args) {
    (void)args;
    MCNextInputEvent ev;
    int n = 0;
    while (mcnext_input_pop(&ev) && n < 4096) n++;
    return fmt("{\"ok\":true,\"dropped\":%d}", n);
}
static char *h_render_env(const char *args) {
    /* args: {"key":"POJAV_RENDERER","value":"gl4es"} —— 必须在 JNI_CreateJavaVM 前 setenv */
    char key[128] = {0}, val[256] = {0};
    const char *k = strstr(args ? args : "", "\"key\"");
    const char *v = strstr(args ? args : "", "\"value\"");
    if (k && (k = strchr(k, ':')) && (k = strchr(k + 1, '"'))) {
        sscanf(k + 1, "%127[^\"]", key);
    }
    if (v && (v = strchr(v, ':')) && (v = strchr(v + 1, '"'))) {
        sscanf(v + 1, "%255[^\"]", val);
    }
    if (!key[0]) return fmt("{\"ok\":false,\"error\":\"缺少 key\"}");
    setenv(key, val, 1);
    LOGI("渲染环境 %s=%s", key, val);
    return fmt("{\"ok\":true,\"key\":\"%s\",\"value\":\"%s\"}", key, val);
}

static const struct { const char *name; handler_t fn; } HANDLERS[] = {
    {"probe.ping",      h_ping},
    {"jvm.status",      h_status},
    {"jvm.lastError",   h_last_error},
    {"jvm.begin",       h_begin},
    {"jvm.end",         h_end},
    {"jvm.requestStop", h_request_stop},
    {"input.key",       h_input_key},
    {"input.mouse",     h_input_mouse},
    {"input.motion",    h_input_motion},
    {"input.reset",     h_input_reset},
    {"render.env",      h_render_env}
};

JNIEXPORT jstring JNICALL
Java_com_mcnext_launcher_BridgeNative_dispatch(JNIEnv *env, jclass clazz,
                                               jstring channel, jstring argsJson) {
    (void)clazz;
    const char *name = channel ? (*env)->GetStringUTFChars(env, channel, NULL) : NULL;
    const char *args = argsJson ? (*env)->GetStringUTFChars(env, argsJson, NULL) : NULL;
    char *result = NULL;
    if (!name) {
        result = fmt("{\"ok\":false,\"error\":\"channel 为空\"}");
    } else {
        handler_t fn = NULL;
        for (size_t i = 0; i < sizeof(HANDLERS) / sizeof(HANDLERS[0]); i++) {
            if (strcmp(name, HANDLERS[i].name) == 0) { fn = HANDLERS[i].fn; break; }
        }
        if (fn) result = fn(args ? args : "{}");
        else result = fmt("{\"ok\":false,\"error\":\"未知 JNI 指令: %s\"}", name);
    }
    if (channel && name) (*env)->ReleaseStringUTFChars(env, channel, name);
    if (argsJson && args) (*env)->ReleaseStringUTFChars(env, argsJson, args);
    jstring out = (*env)->NewStringUTF(env, result ? result : "{\"ok\":false,\"error\":\"JNI 无返回\"}");
    free(result);
    return out;
}
