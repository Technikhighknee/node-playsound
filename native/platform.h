/* SPDX-License-Identifier: CC0-1.0 */
#ifndef PLAYSOUND_PLATFORM_H
#define PLAYSOUND_PLATFORM_H

/* Use operating-system thread/clock APIs, not miniaudio's private helpers. */
#ifdef _WIN32
#include <windows.h>
typedef HANDLE ps_thread;
#define PS_THREAD_RESULT DWORD WINAPI
typedef DWORD (WINAPI *ps_thread_proc)(void*);
static int ps_thread_start(ps_thread* thread, ps_thread_proc proc, void* data)
{
    *thread = CreateThread(NULL, 0, proc, data, 0, NULL);
    return *thread != NULL;
}
static void ps_thread_join(ps_thread thread)
{
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
}
static void ps_sleep(unsigned ms) { Sleep(ms); }
static double ps_seconds(void)
{
    LARGE_INTEGER value, frequency;
    QueryPerformanceCounter(&value);
    QueryPerformanceFrequency(&frequency);
    return (double)value.QuadPart / frequency.QuadPart;
}
#else
#include <pthread.h>
#include <time.h>
#include <errno.h>
#include <unistd.h>
typedef pthread_t ps_thread;
#define PS_THREAD_RESULT void*
typedef void* (*ps_thread_proc)(void*);
static int ps_thread_start(ps_thread* thread, ps_thread_proc proc, void* data)
{
    return pthread_create(thread, NULL, proc, data) == 0;
}
static void ps_thread_join(ps_thread thread) { pthread_join(thread, NULL); }
static void ps_sleep(unsigned ms)
{
    struct timespec delay = { ms / 1000, (long)(ms % 1000) * 1000000L };
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}
static double ps_seconds(void)
{
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec + value.tv_nsec / 1000000000.0;
}
#endif
#endif
