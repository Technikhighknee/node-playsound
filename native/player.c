/* SPDX-License-Identifier: CC0-1.0 */
/* Optional x86 vector features must be selected by runtime dispatch, never
   required by the executable itself. Catch accidental host-CPU builds. */
#if defined(__x86_64__) && (defined(__AVX__) || defined(__AVX2__) || defined(__AVX512F__))
#error "Build the distributed audio engine for the baseline CPU, not the build host."
#endif
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#ifndef PLAYSOUND_TEST
#define MA_NO_NULL
#endif
#include "vendor/miniaudio.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <inttypes.h>

#define MAX_VOICES 256
#define MAX_LINE 131200
#include "platform.h"
#include "stream.h"
typedef struct { unsigned id; ma_sound sound; ps_stream stream; uint64_t seeking; } voice;
static voice voices[MAX_VOICES];
static char mailbox[MAX_LINE];
static ma_mutex inbox_lock;
static int pending;
static atomic_int device_lost;
static unsigned long parent_pid;
#ifdef _WIN32
static HANDLE parent_handle;
#endif

/* EOF alone is insufficient: the reader can be backpressured while a decoder
   is blocked. Monitor the actual parent independently of the command channel. */
static PS_THREAD_RESULT watch_parent(void* unused)
{
    (void)unused;
    for (;;) {
#ifdef _WIN32
        if (WaitForSingleObject(parent_handle, 100) != WAIT_TIMEOUT) _Exit(0);
#else
        if ((unsigned long)getppid() != parent_pid) _Exit(0);
        ps_sleep(100);
#endif
    }
    return 0;
}

/* A single bounded mailbox applies backpressure all the way to Node. Only the
   main thread touches voices. EOF must also terminate a stuck decoder/device. */
static PS_THREAD_RESULT read_commands(void* unused)
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
        /* Bound time spent backpressured too: a terminated Node worker can
           close this pipe while its parent process stays alive. */
        double wait_start = ps_seconds();
        for (;;) {
            int occupied;
            ma_mutex_lock(&inbox_lock);
            occupied = pending;
            ma_mutex_unlock(&inbox_lock);
            if (!occupied) break;
            if ((ps_seconds() - wait_start) >= 10.0) _Exit(3);
            ps_sleep(5);
        }
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
    stream_uninit(&v->stream);
    v->id = 0;
    v->seeking = 0;
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
#ifdef PLAYSOUND_TEST
    /* Simulate a stuck third-party decoder for worker-termination tests. */
    if (!strcmp(line, "BLOCK\n")) { puts("BLOCKED"); ps_sleep(60000); return 1; }
#endif
    char op, extra;
    unsigned id;
    char id_text[11];
    int id_end = 0;
    float volume;
    int offset = 0;
    if (!strcmp(line, "QUIT\n")) return 0;
    /* Bounded decimal fields avoid scanf integer-overflow behavior. */
    if (sscanf(line, "%c %10[0-9]%n", &op, id_text, &id_end) != 2 ||
        (line[id_end] != ' ' && line[id_end] != '\n' && line[id_end] != '\r')) return -1;
    uint64_t parsed_id = strtoull(id_text, NULL, 10);
    if (!parsed_id || parsed_id > UINT32_MAX) return -1;
    id = (unsigned)parsed_id;
    voice* v = NULL;
    for (int i = 0; i < MAX_VOICES; ++i) if (voices[i].id == id) v = &voices[i];
    if (op == 'P' || op == 'B') {
        char path[65537];
        if (v || sscanf(line, "%c %u %f %n", &op, &id, &volume, &offset) != 3 || !offset ||
            !isfinite(volume) || volume < 0 || volume > 1) return -1;
        line[strcspn(line, "\r\n")] = 0;
        if (!unhex(path, line + offset)) return -1;
        for (int i = 0; i < MAX_VOICES; ++i) if (!voices[i].id) { v = &voices[i]; break; }
        if (!v) { printf("ERROR %u LIMIT 0\n", id); return 1; }
        ma_result result = stream_init(&v->stream, path, ma_engine_get_sample_rate(engine));
        if (result != MA_SUCCESS) { printf("ERROR %u DECODE %d\n", id, result); return 1; }
        result = ma_sound_init_from_data_source(engine, &v->stream, MA_SOUND_FLAG_NO_SPATIALIZATION | MA_SOUND_FLAG_NO_PITCH, NULL, &v->sound);
        if (result != MA_SUCCESS) {
            stream_uninit(&v->stream);
            printf("ERROR %u DEVICE %d\n", id, result); return 1;
        }
        if (!stream_attach(&v->stream)) {
            ma_sound_uninit(&v->sound); stream_uninit(&v->stream);
            printf("ERROR %u LIMIT 0\n", id); return 1;
        }
        ma_sound_set_volume(&v->sound, volume);
        stream_pause(&v->stream, op == 'B');
        result = op == 'B' ? MA_SUCCESS : ma_sound_start(&v->sound);
        if (result != MA_SUCCESS) {
            ma_sound_uninit(&v->sound);
            stream_uninit(&v->stream);
            printf("ERROR %u DEVICE %d\n", id, result);
            return 1;
        }
        v->id = id;
        v->seeking = 0;
        printf("STARTED %u\n", id);
    } else if (op == 'Q') {
        double seconds;
        char token_text[17];
        ma_uint32 rate;
        ma_uint64 length;
        if (sscanf(line, "Q %u %lf %16[0-9] %c", &id, &seconds, token_text, &extra) != 3 || !isfinite(seconds) || seconds < 0) return -1;
        uint64_t token = strtoull(token_text, NULL, 10);
        if (!token || token > 9007199254740991ULL) return -1;
        if (!v) return 1; /* Natural completion may have won the command race. */
        if (v->seeking) return -1; /* Controller permits one in-flight seek. */
        ma_result result = ma_sound_get_data_format(&v->sound, NULL, NULL, &rate, NULL, 0);
        if (result == MA_SUCCESS) result = ma_sound_get_length_in_pcm_frames(&v->sound, &length);
        if (result == MA_SUCCESS && rate == 0) result = MA_INVALID_DATA;
        if (result == MA_SUCCESS) {
            /* Compare before multiplying/casting: even DBL_MAX safely ends. */
            if (seconds >= (double)length / rate || ma_sound_at_end(&v->sound)) {
                finish(v, "ended");
                return 1;
            }
            double frames = seconds * rate;
            if (frames >= 18446744073709551616.0) result = MA_OUT_OF_RANGE;
            else stream_request_seek(&v->stream, (ma_uint64)frames);
        }
        if (result != MA_SUCCESS) {
            ma_sound_uninit(&v->sound); stream_uninit(&v->stream); v->id = 0; v->seeking = 0;
            printf("ERROR %u DECODE %d\n", id, result);
        } else v->seeking = token;
    } else if (op == 'A' || op == 'T') {
        char token_text[17], pause_flag = '0';
        if (op == 'A') {
            if (sscanf(line, "A %u %16[0-9] %c %c", &id, token_text, &pause_flag, &extra) != 3 ||
                (pause_flag != '0' && pause_flag != '1')) return -1;
        } else if (sscanf(line, "T %u %16[0-9] %c", &id, token_text, &extra) != 2) return -1;
        int paused = pause_flag == '1';
        uint64_t token = strtoull(token_text, NULL, 10);
        if (!token || token > 9007199254740991ULL) return -1;
        if (!v) return 1;
        /* EOF already observed by the mixer wins; resume must not rewind it. */
        if (ma_sound_at_end(&v->sound)) { finish(v, "ended"); return 1; }
        if (op == 'A') {
            if (paused) stream_pause(&v->stream, 1);
            /* Public node API resumes without ma_sound_start's EOF rewind.
               EOF racing this operation remains terminal on the next poll. */
            ma_result result = ma_node_set_state(&v->sound, paused ? ma_node_state_stopped : ma_node_state_started);
            if (result != MA_SUCCESS) {
                ma_sound_uninit(&v->sound); stream_uninit(&v->stream); v->id = 0; v->seeking = 0;
                printf("ERROR %u DEVICE %d\n", id, result);
                return 1;
            }
            if (!paused) stream_pause(&v->stream, 0);
            printf("PAUSED %u %" PRIu64 " %d\n", id, token, paused);
        } else {
            if (v->seeking) return -1; /* Queries follow the seek acknowledgment. */
            stream_lock(&v->stream);
            ma_uint64 cursor = v->stream.cursor;
            stream_unlock(&v->stream);
            double position = (double)cursor / v->stream.rate;
            if (v->stream.length)
                printf("TIMING %u %" PRIu64 " %.17g %.17g\n", id, token, position, (double)v->stream.length / v->stream.rate);
            else printf("TIMING %u %" PRIu64 " %.17g -\n", id, token, position);
        }
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

static void poll_voices(void)
{
    for (int i = 0; i < MAX_VOICES; ++i) {
        voice* v = &voices[i];
        if (!v->id) continue;
        if (stream_timed_out(&v->stream)) {
            puts("FATAL TIMEOUT 0");
            _Exit(3); /* A decoder job cannot be safely cancelled in-process. */
        }
        ma_bool32 ended = ma_sound_at_end(&v->sound);
        ma_result result = atomic_load(&v->stream.error);
        if (result != MA_SUCCESS) {
            unsigned id = v->id;
            ma_sound_uninit(&v->sound); stream_uninit(&v->stream); v->id = 0; v->seeking = 0;
            printf("ERROR %u DECODE %d\n", id, result);
        } else if (ended) finish(v, "ended");
        else if (v->seeking && !atomic_load(&v->stream.seeking)) {
            if (atomic_load(&v->stream.error) != MA_SUCCESS) continue;
            printf("SEEKED %u %" PRIu64 "\n", v->id, v->seeking);
            v->seeking = 0;
        }
    }
}

int main(int argc, char** argv)
{
    ma_engine engine;
    ma_context context;
    ps_thread reader;
    ps_thread watcher;
    ma_engine_config config = ma_engine_config_init();
    ma_result result;
    char line[MAX_LINE];
    int running = 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    int parent_index = 1;
#ifdef PLAYSOUND_TEST
    if (argc != 4 || strcmp(argv[1], "--null")) return 2;
    parent_index = 2;
#else
    if (argc != 3) return 2;
#endif
    if (strcmp(argv[parent_index], "--parent")) return 2;
    char* end;
    parent_pid = strtoul(argv[parent_index + 1], &end, 10);
    if (!parent_pid || *end || parent_pid > 0xffffffffUL) return 2;
#ifdef _WIN32
    parent_handle = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parent_pid);
    if (!parent_handle) return 2;
#endif
    if (ma_mutex_init(&inbox_lock) != MA_SUCCESS) return 2;
    if (!ps_thread_start(&watcher, watch_parent, NULL)) return 2;
    if (!ps_thread_start(&reader, read_commands, NULL)) return 2;
#ifdef PLAYSOUND_TEST
    ma_backend backend = ma_backend_null;
    result = ma_context_init(&backend, 1, NULL, &context);
#else
    result = ma_context_init(NULL, 0, NULL, &context);
#endif
    if (result != MA_SUCCESS) { printf("FATAL DEVICE %d\n", result); return 1; }
    config.pContext = &context;
    config.notificationCallback = notification;
    result = ma_engine_init(&config, &engine);
    if (result != MA_SUCCESS) { printf("FATAL DEVICE %d\n", result); ma_context_uninit(&context); return 1; }
    if (!stream_pool_init()) { ma_engine_uninit(&engine); ma_context_uninit(&context); return 2; }
    printf("READY 3\n");
    while (running > 0) {
        int have_line;
        ma_mutex_lock(&inbox_lock);
        have_line = pending;
        if (pending) { memcpy(line, mailbox, strlen(mailbox) + 1); pending = 0; }
        ma_mutex_unlock(&inbox_lock);
        if (have_line) running = command(&engine, line);
        if (atomic_load(&device_lost)) { printf("FATAL DEVICE %d\n", MA_DEVICE_NOT_STARTED); running = -1; }
        poll_voices();
        ps_sleep(5);
    }
    for (int i = 0; i < MAX_VOICES; ++i) if (voices[i].id) {
        ma_sound_uninit(&voices[i].sound); stream_uninit(&voices[i].stream);
    }
    stream_pool_uninit();
    ma_engine_uninit(&engine);
    ma_context_uninit(&context);
    /* The reader may be blocked on stdin. Process exit reclaims that thread;
       do not destroy its synchronization objects underneath it. */
    return running < 0 ? 2 : 0;
}
