/* SPDX-License-Identifier: CC0-1.0 */
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#ifndef PLAYSOUND_TEST
#define MA_NO_NULL
#endif
#include "vendor/miniaudio.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

#define MAX_VOICES 256
#define MAX_LINE 131200
typedef struct { unsigned id; ma_sound sound; } voice;
static voice voices[MAX_VOICES];
static char mailbox[MAX_LINE];
static ma_mutex inbox_lock;
static ma_event consumed;
static int pending;
static atomic_int device_lost;

/* A single bounded mailbox applies backpressure all the way to Node. Only the
   main thread touches voices. EOF must also terminate a stuck decoder/device. */
static ma_thread_result MA_THREADCALL read_commands(void* unused)
{
    char line[MAX_LINE];
    (void)unused;
    while (fgets(line, sizeof(line), stdin)) {
        size_t n = strlen(line);
        if (n == 0 || line[n - 1] != '\n') _Exit(2);
        ma_mutex_lock(&inbox_lock);
        memcpy(mailbox, line, n + 1);
        pending = 1;
        ma_mutex_unlock(&inbox_lock);
        ma_event_wait(&consumed);
    }
    _Exit(0);
    return 0;
}

static void notification(const ma_device_notification* event)
{
    if (event->type == ma_device_notification_type_stopped)
        atomic_store(&device_lost, 1);
}

static void finish(voice* v, const char* reason)
{
    unsigned id = v->id;
    ma_sound_uninit(&v->sound);
    v->id = 0;
    printf("DONE %u %s\n", id, reason);
}

static int unhex(char* dest, const char* src)
{
    size_t n = strlen(src);
    if (!n || n % 2 || n > 131072) return 0;
    for (size_t i = 0; i < n; i += 2) {
        int a = src[i], b = src[i + 1];
        a = a >= '0' && a <= '9' ? a - '0' : a >= 'a' && a <= 'f' ? a - 'a' + 10 : -1;
        b = b >= '0' && b <= '9' ? b - '0' : b >= 'a' && b <= 'f' ? b - 'a' + 10 : -1;
        if (a < 0 || b < 0 || (a == 0 && b == 0)) return 0;
        dest[i / 2] = (char)(a * 16 + b);
    }
    dest[n / 2] = 0;
    return 1;
}

static int command(ma_engine* engine, char* line)
{
    char op, extra;
    unsigned id;
    float volume;
    int offset = 0;
    if (!strcmp(line, "QUIT\n")) return 0;
    if (sscanf(line, "%c %u", &op, &id) != 2 || !id) return -1;
    voice* v = NULL;
    for (int i = 0; i < MAX_VOICES; ++i) if (voices[i].id == id) v = &voices[i];
    if (op == 'P') {
        char path[65537];
        if (v || sscanf(line, "P %u %f %n", &id, &volume, &offset) != 2 || !offset ||
            !isfinite(volume) || volume < 0 || volume > 1) return -1;
        line[strcspn(line, "\r\n")] = 0;
        if (!unhex(path, line + offset)) return -1;
        for (int i = 0; i < MAX_VOICES; ++i) if (!voices[i].id) { v = &voices[i]; break; }
        if (!v) { printf("ERROR %u LIMIT 0\n", id); return 1; }
        ma_result result;
#ifdef _WIN32
        wchar_t wide[65537];
        if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 65537)) {
            printf("ERROR %u FILE -2\n", id); return 1;
        }
        result = ma_sound_init_from_file_w(engine, wide, MA_SOUND_FLAG_STREAM | MA_SOUND_FLAG_NO_SPATIALIZATION, NULL, NULL, &v->sound);
#else
        result = ma_sound_init_from_file(engine, path, MA_SOUND_FLAG_STREAM | MA_SOUND_FLAG_NO_SPATIALIZATION, NULL, NULL, &v->sound);
#endif
        if (result != MA_SUCCESS) { printf("ERROR %u DECODE %d\n", id, result); return 1; }
        ma_sound_set_volume(&v->sound, volume);
        result = ma_sound_start(&v->sound);
        if (result != MA_SUCCESS) {
            ma_sound_uninit(&v->sound);
            printf("ERROR %u DEVICE %d\n", id, result);
            return 1;
        }
        v->id = id;
        printf("STARTED %u\n", id);
    } else if (op == 'S') {
        if (sscanf(line, "S %u %c", &id, &extra) != 1) return -1;
        if (v) finish(v, "stopped");
    } else if (op == 'V') {
        if (sscanf(line, "V %u %f %c", &id, &volume, &extra) != 2 ||
            !isfinite(volume) || volume < 0 || volume > 1) return -1;
        if (v) ma_sound_set_volume(&v->sound, volume);
    } else return -1;
    return 1;
}

int main(int argc, char** argv)
{
    ma_engine engine;
    ma_context context;
    ma_thread reader;
    ma_engine_config config = ma_engine_config_init();
    ma_result result;
    char line[MAX_LINE];
    int running = 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    if (ma_mutex_init(&inbox_lock) != MA_SUCCESS || ma_event_init(&consumed) != MA_SUCCESS) return 2;
    if (ma_thread_create(&reader, ma_thread_priority_normal, 0, read_commands, NULL, NULL) != MA_SUCCESS) return 2;
#ifdef PLAYSOUND_TEST
    ma_backend backend = ma_backend_null;
    if (argc != 2 || strcmp(argv[1], "--null")) return 2;
    result = ma_context_init(&backend, 1, NULL, &context);
#else
    (void)argv;
    if (argc != 1) return 2;
    result = ma_context_init(NULL, 0, NULL, &context);
#endif
    if (result != MA_SUCCESS) { printf("FATAL DEVICE %d\n", result); return 1; }
    config.pContext = &context;
    config.notificationCallback = notification;
    result = ma_engine_init(&config, &engine);
    if (result != MA_SUCCESS) { printf("FATAL DEVICE %d\n", result); ma_context_uninit(&context); return 1; }
    printf("READY 1\n");
    while (running > 0) {
        int have_line;
        ma_mutex_lock(&inbox_lock);
        have_line = pending;
        if (pending) { memcpy(line, mailbox, strlen(mailbox) + 1); pending = 0; }
        ma_mutex_unlock(&inbox_lock);
        if (have_line) { ma_event_signal(&consumed); running = command(&engine, line); }
        if (atomic_load(&device_lost)) { printf("FATAL DEVICE %d\n", MA_DEVICE_NOT_STARTED); running = -1; }
        for (int i = 0; i < MAX_VOICES; ++i) {
            voice* v = &voices[i];
            if (!v->id) continue;
            result = ma_resource_manager_data_source_result(v->sound.pResourceManagerDataSource);
            if (result != MA_SUCCESS && result != MA_BUSY) {
                unsigned id = v->id;
                ma_sound_uninit(&v->sound); v->id = 0;
                printf("ERROR %u DECODE %d\n", id, result);
            } else if (ma_sound_at_end(&v->sound)) finish(v, "ended");
        }
        ma_sleep(5);
    }
    for (int i = 0; i < MAX_VOICES; ++i) if (voices[i].id) ma_sound_uninit(&voices[i].sound);
    ma_engine_uninit(&engine);
    ma_context_uninit(&context);
    /* The reader may be blocked on stdin. Process exit reclaims that thread;
       do not destroy its synchronization objects underneath it. */
    return running < 0 ? 2 : 0;
}
