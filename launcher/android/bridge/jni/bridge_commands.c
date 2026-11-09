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
 *
 * ===== 0.9.0 模块一C：JNI 通信防崩溃防线 =====
 * 关键约束：Android 是单进程模型，ART/JVM 自身用 SIGSEGV 实现隐式空指针检查，
 * 因此**不能**用全局常驻 signal handler 覆盖它（会破坏 Java 异常语义）。
 * 本实现把防护严格限定在「一次 dispatch 指令执行窗口」：
 *   - guard_begin()：临时接管 SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGABRT，保存原 handler
 *   - 指令期间若发生同步 native 崩溃 → TLS sigjmp_buf 只回跳**同线程**的 dispatch 帧
 *     → 转成结构化 {ok:false, nativeCrash:true, signal, ...} 返回，Java 层 emit game:crash 弹窗
 *   - guard_end()：窗口结束立刻恢复原 handler，JVM 正常运行期间零干扰
 *   - 崩溃同时用 async-signal-safe 的 open/write/close 落盘标记，供下次启动上报
 *   - 全局互斥锁串行化 guard 窗口，避免并发 dispatch 交错覆盖 s_prev
 *
 * 诚实边界：若崩溃发生在 JVM 内部线程（非本 dispatch 窗口），单进程下会终止整个进程
 * （含 WebView），技术上无法「当场弹窗」；此时靠落盘标记在下次启动由 Java 层读取并弹窗。
 * 指令级同步崩溃（本防线覆盖范围）可当场转弹窗，不闪退。
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
/* 0.9.0 模块一C：信号防护 */
#include <setjmp.h>
#include <signal.h>
#include <fcntl.h>
#include <stdint.h>

#define LOG_TAG "mcnext-bridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

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

/* ==================== 0.9.0 模块一C：JNI 通信防崩溃防线 ==================== */

#define WATCHED_SIGS { SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT }
static const int s_watched[] = WATCHED_SIGS;
#define NWATCHED ((int)(sizeof(s_watched) / sizeof(s_watched[0])))

/* TLS：信号在哪个线程发生，只回跳那个线程的 dispatch 帧，杜绝跨线程 longjmp */
static __thread sigjmp_buf t_guard_jmp;
static __thread volatile sig_atomic_t t_guard_active = 0;

static volatile sig_atomic_t s_last_signal = 0;
static volatile sig_atomic_t s_total_signals = 0;
static char s_crash_path[512] = {0};
static struct sigaction s_prev[NWATCHED];
static pthread_mutex_t s_guard_lock = PTHREAD_MUTEX_INITIALIZER;

static const char *signal_name(int sig) {
    switch (sig) {
        case SIGSEGV: return "SIGSEGV";
        case SIGBUS:  return "SIGBUS";
        case SIGFPE:  return "SIGFPE";
        case SIGILL:  return "SIGILL";
        case SIGABRT: return "SIGABRT";
        default:      return "UNKNOWN";
    }
}

/**
 * async-signal-safe 落盘：只用 open/write/close，手写十进制，不调用
 * snprintf/malloc/log（这些在 signal handler 内非安全）。记录真实信号与名称，
 * 供下次启动由 Java 层读取并弹窗，不编造任何数据。
 */
static void persist_crash_marker(int sig) {
    if (!s_crash_path[0]) return;
    int fd = open(s_crash_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return;
    char buf[160];
    size_t n = 0;
    const char *p;
    const char *prefix = "{\"nativeCrash\":true,\"fatal\":true,\"signal\":";
    for (p = prefix; *p; p++) buf[n++] = *p;
    int v = sig, tn = 0;
    char tmp[16];
    if (v == 0) tmp[tn++] = '0';
    else while (v > 0) { tmp[tn++] = (char)('0' + v % 10); v /= 10; }
    while (tn > 0) buf[n++] = tmp[--tn];
    const char *mid = ",\"signalName\":\"";
    for (p = mid; *p; p++) buf[n++] = *p;
    for (p = signal_name(sig); *p; p++) buf[n++] = *p;
    const char *suffix = "\",\"source\":\"jni-signal\"}";
    for (p = suffix; *p; p++) buf[n++] = *p;
    if (n > sizeof(buf)) n = sizeof(buf);
    (void)write(fd, buf, n);
    close(fd);
}

static void on_native_signal(int sig, siginfo_t *si, void *uc) {
    (void)si; (void)uc;
    s_last_signal = sig;
    s_total_signals++;
    persist_crash_marker(sig);
    if (t_guard_active) {
        /* 指令窗口内的同步崩溃：只回跳同线程帧，转成结构化错误而非进程闪退 */
        t_guard_active = 0;
        siglongjmp(t_guard_jmp, sig > 0 ? sig : 1);
    }
    /* 理论上不会走到（窗口外 handler 已恢复）。若走到，链式转发原 handler，
       保持 ART / 系统既有语义，绝不吞掉别人的崩溃。 */
    int idx = -1;
    for (int i = 0; i < NWATCHED; i++) if (s_watched[i] == sig) { idx = i; break; }
    if (idx >= 0) {
        if (s_prev[idx].sa_flags & SA_SIGINFO) {
            if (s_prev[idx].sa_sigaction) { s_prev[idx].sa_sigaction(sig, si, uc); return; }
        } else {
            void (*h)(int) = s_prev[idx].sa_handler;
            if (h == SIG_DFL) {
                struct sigaction dfl;
                memset(&dfl, 0, sizeof(dfl));
                dfl.sa_handler = SIG_DFL;
                sigemptyset(&dfl.sa_mask);
                sigaction(sig, &dfl, NULL);
                raise(sig);
                return;
            }
            if (h && h != SIG_IGN) { h(sig); return; }
        }
    }
    _exit(128 + sig);
}

static void guard_begin(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = on_native_signal;
    sa.sa_flags = SA_SIGINFO;
    sigemptyset(&sa.sa_mask);
    for (int i = 0; i < NWATCHED; i++) sigaction(s_watched[i], &sa, &s_prev[i]);
    t_guard_active = 1;
}

/** 恢复安装前的 handler；longjmp 跳过 guard_end 时也必须调用 */
static void guard_restore(void) {
    for (int i = 0; i < NWATCHED; i++) sigaction(s_watched[i], &s_prev[i], NULL);
}

static void guard_end(void) {
    t_guard_active = 0;
    guard_restore();
}

/** 崩溃结构化返回（longjmp 回到正常执行流后才调用，可用 malloc/格式化） */
static char *crash_result(int sig) {
    return fmt("{\"ok\":false,\"nativeCrash\":true,\"fatal\":true,\"signal\":%d,"
               "\"signalName\":\"%s\",\"code\":\"NATIVE_CRASH\",\"source\":\"jni\","
               "\"error\":\"JNI 指令执行中发生原生层崩溃(%s)，已安全拦截，启动器不会闪退\"}",
               sig, signal_name(sig), signal_name(sig));
}

/* ==================== 指令处理函数表 ==================== */
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

/**
 * 0.9.0 模块一C：安装 / 查询 JNI 崩溃防线，并消费「上次启动」遗留的崩溃标记。
 * args: {"path":"<app filesDir>/mcnext_native_crash.json"}
 * 返回 lastCrash（合法 JSON 对象或 null）；Java 层据此 emit game:crash 弹窗。
 */
static char *h_crash_guard(const char *args) {
    char path[512] = {0};
    const char *p = strstr(args ? args : "", "\"path\"");
    if (p && (p = strchr(p, ':')) && (p = strchr(p + 1, '"'))) {
        sscanf(p + 1, "%511[^\"]", path);
    }
    if (path[0]) {
        strncpy(s_crash_path, path, sizeof(s_crash_path) - 1);
        s_crash_path[sizeof(s_crash_path) - 1] = '\0';
    }
    char marker[256] = {0};
    int had = 0;
    if (s_crash_path[0]) {
        FILE *f = fopen(s_crash_path, "r");
        if (f) {
            size_t n = fread(marker, 1, sizeof(marker) - 1, f);
            marker[n] = '\0';
            fclose(f);
            had = n > 0;
            remove(s_crash_path);   /* 消费后删除，避免重复弹窗 */
        }
    }
    return fmt("{\"ok\":true,\"installed\":true,\"watchedSignals\":%d,"
               "\"lastSignal\":%d,\"totalSignals\":%d,\"guardActive\":%d,"
               "\"crashPath\":%s,\"lastCrash\":%s}",
               NWATCHED, (int)s_last_signal, (int)s_total_signals, (int)t_guard_active,
               s_crash_path[0] ? "\"set\"" : "null",
               had ? marker : "null");
}

/**
 * 自检：在 guard 窗口内主动触发一次受控非法写，验证「崩溃 → 结构化返回」链路。
 * 必须显式 {"confirm":true}，避免误触；不暴露给 Capacitor UI 契约，仅供真机/JNI 自检。
 */
static char *h_crash_selftest(const char *args) {
    if (!strstr(args ? args : "", "\"confirm\":true")) {
        return fmt("{\"ok\":false,\"error\":\"需显式 confirm:true 才执行崩溃自检\"}");
    }
    volatile int *bad = (volatile int *)0;
    *bad = 1;   /* 触发 SIGSEGV/SIGILL，被本 dispatch 的 siglongjmp 拦截 */
    return fmt("{\"ok\":false,\"error\":\"自检失败：未被防线拦截\"}");
}

static const struct { const char *name; handler_t fn; } HANDLERS[] = {
    {"probe.ping",        h_ping},
    {"jvm.status",        h_status},
    {"jvm.lastError",     h_last_error},
    {"jvm.begin",         h_begin},
    {"jvm.end",           h_end},
    {"jvm.requestStop",   h_request_stop},
    {"input.key",         h_input_key},
    {"input.mouse",       h_input_mouse},
    {"input.motion",      h_input_motion},
    {"input.reset",       h_input_reset},
    {"render.env",        h_render_env},
    /* 0.9.0 模块一C */
    {"probe.crashGuard",  h_crash_guard},
    {"probe.crashSelfTest", h_crash_selftest}
};

JNIEXPORT jstring JNICALL
Java_com_mcnext_launcher_BridgeNative_dispatch(JNIEnv *env, jclass clazz,
                                               jstring channel, jstring argsJson) {
    (void)clazz;
    /* volatile：siglongjmp 后这些值必须仍有效（C 标准对非 volatile 自动变量未定义） */
    const char *volatile name = channel ? (*env)->GetStringUTFChars(env, channel, NULL) : NULL;
    const char *volatile args = argsJson ? (*env)->GetStringUTFChars(env, argsJson, NULL) : NULL;
    char *volatile result = NULL;

    /* 全局锁串行化 guard 窗口：并发 dispatch 不得交错覆盖 s_prev。
       longjmp 回到 sigsetjmp 之后仍持有该锁，两个分支都会走到 unlock。 */
    pthread_mutex_lock(&s_guard_lock);
    volatile int jumped = sigsetjmp(t_guard_jmp, 1);
    if (jumped == 0) {
        guard_begin();
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
        guard_end();
    } else {
        t_guard_active = 0;
        guard_restore();          /* longjmp 跳过了 guard_end，必须恢复原 handler */
        result = crash_result((int)jumped);
        LOGW("JNI 指令原生层崩溃已拦截: signal=%d (%s)", (int)jumped, signal_name((int)jumped));
    }
    pthread_mutex_unlock(&s_guard_lock);

    /* JNI 层若抛出 Java 异常，清理掉，避免污染后续调用 */
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        free(result);
        result = fmt("{\"ok\":false,\"error\":\"JNI 层抛出 Java 异常，已清理\"}");
    }

    if (channel && name) (*env)->ReleaseStringUTFChars(env, channel, name);
    if (argsJson && args) (*env)->ReleaseStringUTFChars(env, argsJson, args);
    jstring out = (*env)->NewStringUTF(env, result ? result : "{\"ok\":false,\"error\":\"JNI 无返回\"}");
    free(result);
    return out;
}
