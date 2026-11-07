/**
 * input_bridge.c — 触控 / 手柄事件从 Java 层透传到 JVM 内的 LWJGL 移植层
 *
 * 真实机制（与 PojavLauncher 的 CallbackBridge 同构）：
 *  Android UI 线程把按键 / 鼠标 / 摇杆事件写入 native 环形缓冲（带锁），
 *  JVM 侧的 LWJGL-native 通过 nativePoll() 轮询取走并注入 glfwPollEvents 队列。
 *  这样触屏与外接手柄都能驱动游戏内输入，不依赖 WebView 或辅助功能服务。
 */
#include "mcnext_jni.h"
#include <android/log.h>
#include <string.h>
#include <time.h>

#define LOG_TAG "mcnext-input"
#define QUEUE_SIZE 512

static MCNextInputEvent g_queue[QUEUE_SIZE];
static volatile int g_head = 0;
static volatile int g_tail = 0;
static pthread_mutex_t g_queue_lock = PTHREAD_MUTEX_INITIALIZER;
static float g_mouse_sensitivity = 1.0f;

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

void mcnext_input_push(int type, int a, int b, float x, float y) {
    pthread_mutex_lock(&g_queue_lock);
    int next = (g_tail + 1) % QUEUE_SIZE;
    if (next == g_head) g_head = (g_head + 1) % QUEUE_SIZE; /* 满则丢弃最旧事件 */
    MCNextInputEvent *e = &g_queue[g_tail];
    e->type = type; e->a = a; e->b = b; e->x = x; e->y = y; e->when = now_ms();
    g_tail = next;
    pthread_mutex_unlock(&g_queue_lock);
}

int mcnext_input_pop(MCNextInputEvent *out) {
    pthread_mutex_lock(&g_queue_lock);
    if (g_head == g_tail) { pthread_mutex_unlock(&g_queue_lock); return 0; }
    *out = g_queue[g_head];
    g_head = (g_head + 1) % QUEUE_SIZE;
    pthread_mutex_unlock(&g_queue_lock);
    return 1;
}

JNIEXPORT jboolean JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativeSendKey(JNIEnv *env, jclass clazz,
                                                          jint keycode, jint scancode, jboolean pressed) {
    (void)env; (void)clazz;
    mcnext_input_push(EV_KEY, keycode, scancode, 0.0f, pressed ? 1.0f : 0.0f);
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativeSendMouse(JNIEnv *env, jclass clazz,
                                                            jint button, jboolean pressed,
                                                            jfloat x, jfloat y) {
    (void)env; (void)clazz;
    mcnext_input_push(EV_MOUSE, button, pressed ? 1 : 0, x, y);
}

JNIEXPORT void JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativeSendMotion(JNIEnv *env, jclass clazz,
                                                             jfloat dx, jfloat dy) {
    (void)env; (void)clazz;
    mcnext_input_push(EV_MOTION, 0, 0, dx * g_mouse_sensitivity, dy * g_mouse_sensitivity);
}

JNIEXPORT void JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativeSetSensitivity(JNIEnv *env, jclass clazz, jfloat s) {
    (void)env; (void)clazz;
    if (s > 0.05f && s < 20.0f) g_mouse_sensitivity = s;
}

/**
 * JVM 侧轮询：out = [type, a, b, x*1000, y*1000, timestampMs(低 32 位)]
 * 返回 0 表示队列为空，1 表示取到事件。
 */
JNIEXPORT jint JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativePoll(JNIEnv *env, jclass clazz, jintArray out) {
    (void)clazz;
    MCNextInputEvent e;
    if (!mcnext_input_pop(&e)) return 0;
    jint buf[6] = { e.type, e.a, e.b, (jint)(e.x * 1000), (jint)(e.y * 1000), (jint)(e.when & 0x7fffffff) };
    (*env)->SetIntArrayRegion(env, out, 0, 6, buf);
    return 1;
}

JNIEXPORT jint JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativePending(JNIEnv *env, jclass clazz) {
    (void)env; (void)clazz;
    pthread_mutex_lock(&g_queue_lock);
    int n = (g_tail - g_head + QUEUE_SIZE) % QUEUE_SIZE;
    pthread_mutex_unlock(&g_queue_lock);
    return n;
}

JNIEXPORT void JNICALL
Java_com_mcnext_launcher_input_InputBridge_nativeReset(JNIEnv *env, jclass clazz) {
    (void)env; (void)clazz;
    pthread_mutex_lock(&g_queue_lock);
    g_head = g_tail = 0;
    memset(g_queue, 0, sizeof(g_queue));
    pthread_mutex_unlock(&g_queue_lock);
}
