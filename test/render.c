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

int main(int argc, char** argv)
{
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
