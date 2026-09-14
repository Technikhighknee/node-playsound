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
        voices[i].id = 0;
    }
    ma_engine_uninit(&engine);
    return energy;
}

static ma_result fail_seek(ma_data_source* source, ma_uint64 frame)
{
    (void)source; (void)frame;
    return MA_BAD_SEEK;
}

static ma_result fail_read(ma_data_source* source, void* out, ma_uint64 count, ma_uint64* read)
{
    (void)source; (void)out; (void)count;
    *read = 0;
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
    ma_data_source_base* backend = (ma_data_source_base*)voices[0].sound.pResourceManagerDataSource->backend.stream.decoder.pBackend;
    ma_data_source_vtable vtable = *backend->vtable;
    if (!strcmp(mode, "fail-seek")) vtable.onSeek = fail_seek;
    if (!strcmp(mode, "fail-read")) vtable.onRead = fail_read;
    backend->vtable = &vtable; /* Initialization has finished; no device is reading. */
    if (!strcmp(mode, "unknown-length")) voices[0].sound.pResourceManagerDataSource->backend.stream.totalLengthInPCMFrames = 0;
    for (int pass = 0; pass < 2; pass++) {
        snprintf(line, sizeof(line), "Q 1 %s\n", pass ? "0" : "0.75");
        if (command(&engine, line) != 1) return 1;
        float pcm[960];
        /* The real mixing callback consumes the seek request. */
        if (ma_engine_read_pcm_frames(&engine, pcm, 480, NULL) != MA_SUCCESS) return 1;
        ma_timer timer; ma_timer_init(&timer);
        do {
            poll_voices();
            if (ma_timer_get_time_in_seconds(&timer) > 5) return 1;
            ma_sleep(1);
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

int main(int argc, char** argv)
{
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
