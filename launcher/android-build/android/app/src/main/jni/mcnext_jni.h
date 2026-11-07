#ifndef MCNEXT_JNI_H
#define MCNEXT_JNI_H

#include <jni.h>
#include <pthread.h>

/* JVM 状态 */
extern JavaVM *g_mcnext_vm;
extern pthread_mutex_t g_mcnext_lock;
extern char g_mcnext_error[1024];

/* 输入事件类型（供 JVM 侧 LWJGL 移植层轮询） */
#define EV_NONE   0
#define EV_KEY    1
#define EV_MOUSE  2
#define EV_MOTION 3

typedef struct {
    int type;
    int a;          /* keycode / mouse button */
    int b;          /* scancode / pressed */
    float x, y;     /* pointer / axis */
    long long when; /* 毫秒时间戳 */
} MCNextInputEvent;

void mcnext_input_push(int type, int a, int b, float x, float y);
int  mcnext_input_pop(MCNextInputEvent *out);

#endif /* MCNEXT_JNI_H */
