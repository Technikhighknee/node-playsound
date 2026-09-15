/* Exercise our command handling against actual decoded and mixed PCM, without
   relying on a speaker or replacing miniaudio with a mock. */
#define main worker_main
#include "../native/player.c"
#undef main

static double render(const char* hex, float volume, int count, int change)
{
    ma_engine engine;
    ma_engine_config config = ma_engine_config_init();
    config.noDevice = MA_TRUE;
    config.channels = 2;
    config.sampleRate = 48000;
    if (ma_engine_init(&config, &engine) != MA_SUCCESS) return -1;
    for (int i = 1; i <= count; i++) {
        char line[MAX_LINE];
        snprintf(line, sizeof(line), "P %d %f %s\n", i, change ? 1.0f : volume, hex);
        if (command(&engine, line) != 1 || voices[i - 1].id != (unsigned)i) return -1;
        if (change) {
            snprintf(line, sizeof(line), "V %d %f\n", i, volume);
            if (command(&engine, line) != 1) return -1;
        }
    }
    double energy = 0;
    for (int block = 0; block < 10; block++) {
        float pcm[960];
        if (ma_engine_read_pcm_frames(&engine, pcm, 480, NULL) != MA_SUCCESS) return -1;
        for (int i = 0; i < 960; i++) energy += pcm[i] * pcm[i];
    }
    for (int i = 0; i < count; i++) {
        ma_sound_uninit(&voices[i].sound);
        stream_uninit(&voices[i].stream);
        voices[i].id = 0;
    }
    ma_engine_uninit(&engine);
    return energy;
}

static ma_result fail_seek(ma_decoder* source, ma_uint64 frame)
{
    (void)source; (void)frame;
    return MA_BAD_SEEK;
}

static ma_result fail_read(ma_decoder* source, void* out, ma_uint64 count, ma_uint64* read)
{
    (void)source; (void)out; (void)count;
    *read = 0;
    return MA_IO_ERROR;
}

static ma_event entered, release_read;
static atomic_int gate_next, gate_error, closed;
static ma_result gated_read(ma_decoder* decoder, void* out, ma_uint64 count, ma_uint64* read)
{
    if (atomic_exchange(&gate_next, 0)) {
        ma_event_signal(&entered);
        ma_event_wait(&release_read);
        if (atomic_load(&gate_error)) { *read = 0; return MA_IO_ERROR; }
    }
    return ma_decoder_read_pcm_frames(decoder, out, count, read);
}
static PS_THREAD_RESULT close_stream(void* data)
{
    stream_uninit(data);
    atomic_store(&closed, 1);
    return 0;
}

/* Compare streaming output with an independent synchronous decoder, including
   wrap-around, a blocked refill, a concurrent seek, and worker retirement. */
static int buffering(const char* hex, const char* mode)
{
    char path[65537];
    if (!unhex(path, hex)) return 1;
    ps_stream source, peer;
    if (stream_init(&source, path, 48000) != MA_SUCCESS) return 1;
    if (stream_init(&peer, path, 48000) != MA_SUCCESS) return 1;
    // Reference shares no decoder, PCM buffer, or worker with the source.
    ma_decoder reference;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 2, 48000);
#ifdef _WIN32
    wchar_t wide[65537];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 65537)) return 1;
    if (ma_decoder_init_file_w(wide, &config, &reference) != MA_SUCCESS) return 1;
#else
    if (ma_decoder_init_file(path, &config, &reference) != MA_SUCCESS) return 1;
#endif
    if (ma_event_init(&entered) != MA_SUCCESS || ma_event_init(&release_read) != MA_SUCCESS) return 1;
    atomic_store(&gate_next, 1);
    atomic_store(&gate_error, !strcmp(mode, "stale-error"));
    source.read = gated_read;
    if (!stream_attach(&source) || !stream_attach(&peer)) return 1;
    float actual[STREAM_CHUNK * 2], expected[STREAM_CHUNK * 2];
    ma_uint64 count;
    if (stream_read(&source, actual, STREAM_CHUNK, &count) != MA_SUCCESS || count != STREAM_CHUNK) return 1;
    ma_event_wait(&entered); // The source decoder is now blocked outside its lock.
    // The other worker must keep its own decoder moving across buffer wraps.
    ma_uint64 total = 0;
    double start = ps_seconds();
    for (;;) {
        ma_result result = stream_read(&peer, actual, 997, &count);
        if (result == MA_AT_END) break;
        if (result == MA_BUSY) { if (ps_seconds() - start > 5) return 1; ps_sleep(1); continue; }
        ma_uint64 reference_count;
        if (ma_decoder_read_pcm_frames(&reference, expected, count, &reference_count) != MA_SUCCESS || count != reference_count) return 1;
        for (ma_uint64 i = 0; i < count * 2; i++) if (fabs(actual[i] - expected[i]) > 0.000001) return 1;
        total += count;
    }
    if (total != source.length || total <= STREAM_CAPACITY * 2) return 1;
    stream_uninit(&peer);
    if (!strcmp(mode, "close-refill")) {
        ps_thread closing;
        atomic_store(&closed, 0);
        if (!ps_thread_start(&closing, close_stream, &source)) return 1;
        ps_sleep(20);
        if (atomic_load(&closed)) return 1;
        ma_event_signal(&release_read);
        ps_thread_join(closing);
        if (!atomic_load(&closed)) return 1;
    } else {
        stream_request_seek(&source, 96000);
        if (stream_read(&source, actual, 480, &count) != MA_BUSY || count != 0) return 1;
        ma_event_signal(&release_read);
        start = ps_seconds();
        while (atomic_load(&source.seeking) && atomic_load(&source.error) == MA_SUCCESS) {
            if (ps_seconds() - start > 5) return 1;
            ps_sleep(1);
        }
        if (!strcmp(mode, "stale-error")) {
            if (atomic_load(&source.error) != MA_IO_ERROR) return 1;
        } else {
            if (atomic_load(&source.error) != MA_SUCCESS) return 1;
            if (stream_read(&source, actual, 480, &count) != MA_SUCCESS || count != 480) return 1;
            if (ma_decoder_seek_to_pcm_frame(&reference, 96000) != MA_SUCCESS) return 1;
            ma_uint64 reference_count;
            if (ma_decoder_read_pcm_frames(&reference, expected, 480, &reference_count) != MA_SUCCESS || reference_count != 480) return 1;
            for (int i = 0; i < 960; i++) if (fabs(actual[i] - expected[i]) > 0.000001) return 1;
        }
        stream_uninit(&source);
    }
    ma_decoder_uninit(&reference);
    ma_event_uninit(&entered); ma_event_uninit(&release_read);
    puts("STREAM_OK");
    return 0;
}

static ma_result stalled_read(ma_decoder* source, void* out, ma_uint64 count, ma_uint64* read)
{
    (void)source; (void)out; (void)count; (void)read;
    ps_sleep(60000);
    return MA_IO_ERROR;
}

static int seeking(const char* hex, const char* mode)
{
    ma_engine engine;
    ma_engine_config config = ma_engine_config_init();
    config.noDevice = MA_TRUE; config.channels = 2; config.sampleRate = 48000;
    if (ma_engine_init(&config, &engine) != MA_SUCCESS) return 1;
    char line[MAX_LINE];
    snprintf(line, sizeof(line), "P 1 1 %s\n", hex);
    if (command(&engine, line) != 1 || voices[0].id != 1) return 1;
    ps_stream* source = &voices[0].stream;
    stream_detach(source); // Quiesce its decoder before replacing operations.
    if (!strcmp(mode, "fail-seek")) source->seek = fail_seek;
    if (!strcmp(mode, "fail-read")) source->read = fail_read;
    if (!strcmp(mode, "stall")) source->read = stalled_read;
    if (!strcmp(mode, "unknown-length")) source->length = 0;
    if (!stream_attach(source)) return 1;
    for (int pass = 0; pass < 2; pass++) {
        snprintf(line, sizeof(line), "Q 1 %s\n", pass ? "0" : "0.75");
        if (command(&engine, line) != 1) return 1;
        float pcm[960];
        /* The mixer may consume only the newly published PCM, never decode. */
        if (ma_engine_read_pcm_frames(&engine, pcm, 480, NULL) != MA_SUCCESS) return 1;
        double start = ps_seconds();
        do {
            poll_voices();
            if ((ps_seconds() - start) > (!strcmp(mode, "stall") ? 12 : 5)) return 1;
            ps_sleep(1);
        } while (voices[0].id && voices[0].seeking);
        if (strcmp(mode, "seek")) {
            if (voices[0].id != 0) return 1;
            ma_engine_uninit(&engine);
            puts("SEEK_FAILURE_OK");
            return 0;
        }
        if (voices[0].id != 1) return 1;
        /* Drain one block of mixer buffering, then inspect actual samples:
           fixture first half is silent, second half has a tone. */
        ma_engine_read_pcm_frames(&engine, pcm, 480, NULL);
        if (ma_engine_read_pcm_frames(&engine, pcm, 480, NULL) != MA_SUCCESS) return 1;
        double energy = 0;
        for (int i = 0; i < 960; i++) energy += pcm[i] * pcm[i];
        if ((!pass && energy < 0.01) || (pass && energy != 0)) return 1;
    }
    finish(&voices[0], "stopped");
    ma_engine_uninit(&engine);
    puts("SEEK_PCM_OK");
    return 0;
}

static int run(int argc, char** argv)
{
    if (argc == 3 && (!strcmp(argv[2], "seek-refill") || !strcmp(argv[2], "close-refill") || !strcmp(argv[2], "stale-error")))
        return buffering(argv[1], argv[2]);
    if (argc == 3) return seeking(argv[1], argv[2]);
    if (argc != 2) return 2;
    double full = render(argv[1], 1, 1, 0);
    double quiet = render(argv[1], 0.25f, 1, 0);
    double changed = render(argv[1], 0.25f, 1, 1);
    double mute = render(argv[1], 0, 1, 0);
    double mixed = render(argv[1], 1, 2, 0);
    if (full <= 0 || fabs(quiet / full - 0.0625) > 0.001 ||
        fabs(changed / full - 0.0625) > 0.001 || mute != 0 || fabs(mixed / full - 4) > 0.01) {
        fprintf(stderr, "Unexpected PCM energy: %f %f %f %f %f\n", full, quiet, changed, mute, mixed);
        return 1;
    }
    puts("PCM_OK");
    return 0;
}

int main(int argc, char** argv)
{
    if (!stream_pool_init()) return 2;
    int result = run(argc, argv);
    stream_pool_uninit();
    return result;
}
