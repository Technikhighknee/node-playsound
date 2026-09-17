/* SPDX-License-Identifier: CC0-1.0 */
#ifndef PLAYSOUND_STREAM_H
#define PLAYSOUND_STREAM_H

/* A public miniaudio data source. Decoders belong exclusively to a bounded
   worker pool; the mixer only copies already-decoded PCM. No file I/O, heap
   allocation, or waiting for another thread is allowed in the audio callback. */
#define STREAM_CAPACITY 16384
#define STREAM_CHUNK 4096
#define STREAM_WORKERS 2

typedef struct {
    ma_data_source_base base;
    ma_decoder decoder;
    ma_uint32 rate;
    ma_uint64 length;
    float* pcm;
    atomic_flag lock;
    atomic_int error;
    atomic_int seeking;
    unsigned read_pos, count;
    int eof, seek_pending, paused;
    ma_uint64 target, generation, cursor;
    /* Pool mutex protects membership, busy, and busy_since. */
    int busy;
    double busy_since;
    /* Explicit decoder boundary also permits deterministic fault injection. */
    ma_result (*read)(ma_decoder*, void*, ma_uint64, ma_uint64*);
    ma_result (*seek)(ma_decoder*, ma_uint64);
} ps_stream;

static void stream_lock(ps_stream* s)
{
    while (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) ps_sleep(1);
}
static void stream_unlock(ps_stream* s) { atomic_flag_clear_explicit(&s->lock, memory_order_release); }

static ma_result stream_read(ma_data_source* source, void* out, ma_uint64 requested, ma_uint64* read)
{
    ps_stream* s = (ps_stream*)source;
    *read = 0;
    if (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) return MA_BUSY;
    if (s->paused || atomic_load(&s->seeking) || atomic_load(&s->error) != MA_SUCCESS) {
        stream_unlock(s);
        return MA_BUSY; /* Main thread reports errors and destroys the voice. */
    }
    unsigned count = requested < s->count ? (unsigned)requested : s->count;
    unsigned first = count < STREAM_CAPACITY - s->read_pos ? count : STREAM_CAPACITY - s->read_pos;
    if (out != NULL) {
        memcpy(out, s->pcm + s->read_pos * 2, first * 2 * sizeof(float));
        memcpy((float*)out + first * 2, s->pcm, (count - first) * 2 * sizeof(float));
    }
    s->read_pos = (s->read_pos + count) % STREAM_CAPACITY;
    s->count -= count;
    s->cursor += count;
    *read = count;
    ma_result result = count ? MA_SUCCESS : s->eof ? MA_AT_END : MA_BUSY;
    stream_unlock(s);
    return result;
}

/* Main-thread gate synchronizes with any in-progress PCM copy. */
static void stream_pause(ps_stream* s, int paused)
{
    stream_lock(s);
    s->paused = paused;
    stream_unlock(s);
}

static ma_result stream_format(ma_data_source* source, ma_format* format, ma_uint32* channels,
    ma_uint32* rate, ma_channel* map, size_t map_capacity)
{
    ps_stream* s = (ps_stream*)source;
    if (format) *format = ma_format_f32;
    if (channels) *channels = 2;
    if (rate) *rate = s->rate;
    if (map) ma_channel_map_init_standard(ma_standard_channel_map_default, map, map_capacity, 2);
    return MA_SUCCESS;
}
static ma_result stream_cursor(ma_data_source* source, ma_uint64* cursor)
{
    ps_stream* s = (ps_stream*)source;
    if (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) return MA_BUSY;
    *cursor = s->cursor;
    stream_unlock(s);
    return MA_SUCCESS;
}
static ma_result stream_length(ma_data_source* source, ma_uint64* length)
{
    *length = ((ps_stream*)source)->length;
    return *length ? MA_SUCCESS : MA_NOT_IMPLEMENTED;
}
static const ma_data_source_vtable stream_vtable = {
    stream_read, NULL, stream_format, stream_cursor, stream_length, NULL, 0
};

static int stream_needs_work(ps_stream* s)
{
    if (atomic_load(&s->error) != MA_SUCCESS) return 0;
    if (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) return 0;
    int needed = s->seek_pending || (!s->eof && s->count <= STREAM_CAPACITY - STREAM_CHUNK);
    stream_unlock(s);
    return needed;
}

/* Only the owner of a pool job (or initialization before registration) calls
   this. Disk work happens outside both the pool mutex and the PCM lock. */
static void stream_step(ps_stream* s)
{
    float scratch[STREAM_CHUNK * 2];
    stream_lock(s);
    int seek = s->seek_pending;
    s->seek_pending = 0;
    ma_uint64 target = s->target, generation = s->generation;
    stream_unlock(s);
    ma_result result = seek ? s->seek(&s->decoder, target) : MA_SUCCESS;
    ma_uint64 count = 0;
    if (result == MA_SUCCESS) result = s->read(&s->decoder, scratch, STREAM_CHUNK, &count);
    if (count > STREAM_CHUNK) { result = MA_INVALID_DATA; count = 0; }
    stream_lock(s);
    /* A seek can arrive while a refill is decoding: discard old PCM/EOF,
       but never hide a real decoder failure behind a newer request. */
    if (result != MA_SUCCESS && result != MA_AT_END) atomic_store(&s->error, result);
    if (generation == s->generation) {
        if (result == MA_SUCCESS || result == MA_AT_END) {
            unsigned write_pos = (s->read_pos + s->count) % STREAM_CAPACITY;
            unsigned first = count < STREAM_CAPACITY - write_pos ? (unsigned)count : STREAM_CAPACITY - write_pos;
            memcpy(s->pcm + write_pos * 2, scratch, first * 2 * sizeof(float));
            memcpy(s->pcm, scratch + first * 2, ((unsigned)count - first) * 2 * sizeof(float));
            s->count += (unsigned)count;
            s->eof = result == MA_AT_END || count < STREAM_CHUNK;
        }
        if (seek) atomic_store(&s->seeking, 0); /* Result and PCM are published first. */
    }
    stream_unlock(s);
}

static void stream_request_seek(ps_stream* s, ma_uint64 frame)
{
    stream_lock(s);
    s->generation++;
    s->target = frame;
    s->cursor = frame;
    s->read_pos = s->count = 0;
    s->eof = 0;
    s->seek_pending = 1;
    atomic_store(&s->seeking, 1);
    stream_unlock(s);
}

static ma_result stream_init(ps_stream* s, const char* path, ma_uint32 rate)
{
    *s = (ps_stream){ .lock = ATOMIC_FLAG_INIT };
    atomic_init(&s->error, MA_SUCCESS);
    atomic_init(&s->seeking, 0);
    s->rate = rate;
    s->read = ma_decoder_read_pcm_frames;
    s->seek = ma_decoder_seek_to_pcm_frame;
    s->pcm = malloc(STREAM_CAPACITY * 2 * sizeof(float));
    if (!s->pcm) return MA_OUT_OF_MEMORY;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 2, rate);
    ma_result result;
#ifdef _WIN32
    wchar_t wide[65537];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 65537)) {
        free(s->pcm); return MA_INVALID_ARGS;
    }
    result = ma_decoder_init_file_w(wide, &config, &s->decoder);
#else
    result = ma_decoder_init_file(path, &config, &s->decoder);
#endif
    if (result != MA_SUCCESS) { free(s->pcm); return result; }
    if (ma_decoder_get_length_in_pcm_frames(&s->decoder, &s->length) != MA_SUCCESS) s->length = 0;
    ma_data_source_config source_config = ma_data_source_config_init();
    source_config.vtable = &stream_vtable;
    result = ma_data_source_init(&source_config, &s->base);
    if (result == MA_SUCCESS) {
        while (stream_needs_work(s)) stream_step(s);
        result = atomic_load(&s->error);
        if (result == MA_SUCCESS) return result;
        ma_data_source_uninit(&s->base);
    }
    ma_decoder_uninit(&s->decoder);
    free(s->pcm);
    return result;
}

static ma_mutex stream_pool_lock;
static ps_stream* stream_pool[MAX_VOICES];
static ps_thread stream_threads[STREAM_WORKERS];
static atomic_int stream_pool_stopping;
static unsigned stream_next;

static PS_THREAD_RESULT stream_worker(void* unused)
{
    (void)unused;
    while (!atomic_load(&stream_pool_stopping)) {
        ps_stream* job = NULL;
        ma_mutex_lock(&stream_pool_lock);
        for (unsigned i = 0; i < MAX_VOICES; i++) {
            unsigned index = (stream_next + i) % MAX_VOICES;
            ps_stream* candidate = stream_pool[index];
            if (candidate && !candidate->busy && stream_needs_work(candidate)) {
                job = candidate;
                job->busy = 1;
                job->busy_since = ps_seconds();
                stream_next = (index + 1) % MAX_VOICES;
                break;
            }
        }
        ma_mutex_unlock(&stream_pool_lock);
        if (!job) { ps_sleep(2); continue; }
        stream_step(job);
        ma_mutex_lock(&stream_pool_lock);
        job->busy = 0;
        ma_mutex_unlock(&stream_pool_lock);
    }
    return 0;
}

static int stream_pool_init(void)
{
    if (ma_mutex_init(&stream_pool_lock) != MA_SUCCESS) return 0;
    atomic_store(&stream_pool_stopping, 0);
    for (int i = 0; i < STREAM_WORKERS; i++) {
        if (!ps_thread_start(&stream_threads[i], stream_worker, NULL)) {
            atomic_store(&stream_pool_stopping, 1);
            for (int j = 0; j < i; j++) ps_thread_join(stream_threads[j]);
            ma_mutex_uninit(&stream_pool_lock);
            return 0;
        }
    }
    return 1;
}
static int stream_attach(ps_stream* s)
{
    int added = 0;
    ma_mutex_lock(&stream_pool_lock);
    for (int i = 0; i < MAX_VOICES; i++) if (!stream_pool[i]) { stream_pool[i] = s; added = 1; break; }
    ma_mutex_unlock(&stream_pool_lock);
    return added;
}
static void stream_detach(ps_stream* s)
{
    ma_mutex_lock(&stream_pool_lock);
    for (int i = 0; i < MAX_VOICES; i++) if (stream_pool[i] == s) stream_pool[i] = NULL;
    while (s->busy) {
        ma_mutex_unlock(&stream_pool_lock);
        ps_sleep(1);
        ma_mutex_lock(&stream_pool_lock);
    }
    ma_mutex_unlock(&stream_pool_lock);
}
static int stream_timed_out(ps_stream* s)
{
    ma_mutex_lock(&stream_pool_lock);
    int timed_out = s->busy && ps_seconds() - s->busy_since >= 10.0;
    ma_mutex_unlock(&stream_pool_lock);
    return timed_out;
}
/* Detach sound from the mixer first; then wait for its decoder job before
   releasing any stream memory. Node's stop/close kill deadline bounds a hang. */
static void stream_uninit(ps_stream* s)
{
    stream_detach(s);
    ma_decoder_uninit(&s->decoder);
    ma_data_source_uninit(&s->base);
    free(s->pcm);
}
static void stream_pool_uninit(void)
{
    atomic_store(&stream_pool_stopping, 1);
    for (int i = 0; i < STREAM_WORKERS; i++) ps_thread_join(stream_threads[i]);
    ma_mutex_uninit(&stream_pool_lock);
}
#endif
