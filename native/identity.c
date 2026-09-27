/* SPDX-License-Identifier: CC0-1.0 */
#include "identity.h"
#include <string.h>

static int digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

int ps_identity_decode(const char* hex, char name[256])
{
    size_t n = strlen(hex);
    if (!n || n > 510 || n % 2) return 0;
    n /= 2;
    for (size_t i = 0; i < n; ++i) {
        int a = digit(hex[2*i]), b = digit(hex[2*i+1]);
        if (a < 0 || b < 0) return 0;
        name[i] = (char)((a << 4) | b);
    }
    name[n] = 0;
    int nonblank = 0;
    for (size_t i = 0; i < n;) {
        uint32_t c = (unsigned char)name[i++], minimum = 0;
        unsigned more = 0;
        if (c >= 0xc2 && c <= 0xdf) { c &= 31; more = 1; minimum = 0x80; }
        else if (c >= 0xe0 && c <= 0xef) { c &= 15; more = 2; minimum = 0x800; }
        else if (c >= 0xf0 && c <= 0xf4) { c &= 7; more = 3; minimum = 0x10000; }
        else if (c >= 0x80) return 0;
        while (more--) {
            if (i == n || ((unsigned char)name[i] & 0xc0) != 0x80) return 0;
            c = (c << 6) | ((unsigned char)name[i++] & 63);
        }
        if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) ||
            c < 32 || (c >= 127 && c <= 159)) return 0;
        if (!(c == 32 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
              c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff)) nonblank = 1;
    }
    return nonblank;
}

#ifdef _WIN32
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
/* SDK interfaces in a separate translation unit: no miniaudio internals. */
static const GUID enumerator_class = {0xbcde0395,0xe52f,0x467c,{0x8e,0x3d,0xc4,0x57,0x92,0x91,0x69,0x2e}};
static const GUID enumerator_iid = {0xa95664d2,0x9614,0x4f35,{0xa7,0x46,0xde,0x8d,0xb6,0x36,0x17,0xe6}};
static const GUID manager_iid = {0x77aa99a0,0x1bd6,0x484f,{0x8b,0xc7,0x2c,0x65,0x4c,0x9a,0x9b,0x6f}};
static const GUID control_iid = {0xbfb7ff88,0x7239,0x4fc9,{0x8f,0xa2,0x07,0xc9,0x50,0xbe,0x9c,0x6d}};
static IAudioSessionControl* retained;
static int initialized;

int32_t ps_identity_set(const char* name)
{
    WCHAR wide[256];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide, 256)) return E_INVALIDARG;
    HRESULT hr;
    if (!initialized) {
        hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        if (FAILED(hr)) return hr;
        initialized = 1;
    }
    IMMDeviceEnumerator* enumerator = NULL;
    IMMDeviceCollection* devices = NULL;
    hr = CoCreateInstance(&enumerator_class, NULL, CLSCTX_ALL, &enumerator_iid, (void**)&enumerator);
    if (FAILED(hr)) return hr;
    hr = IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &devices);
    if (SUCCEEDED(hr)) {
        UINT count = 0;
        hr = IMMDeviceCollection_GetCount(devices, &count);
        HRESULT outcome = E_FAIL;
        HRESULT naming_failure = S_OK;
        for (UINT i = 0; SUCCEEDED(hr) && i < count; ++i) {
            IMMDevice* device = NULL;
            IAudioSessionManager2* manager = NULL;
            IAudioSessionEnumerator* sessions = NULL;
            HRESULT step = IMMDeviceCollection_Item(devices, i, &device);
            if (SUCCEEDED(step)) step = IMMDevice_Activate(device, &manager_iid, CLSCTX_ALL, NULL, (void**)&manager);
            if (SUCCEEDED(step)) step = IAudioSessionManager2_GetSessionEnumerator(manager, &sessions);
            int total = 0;
            if (SUCCEEDED(step)) step = IAudioSessionEnumerator_GetCount(sessions, &total);
            for (int j = 0; SUCCEEDED(step) && j < total; ++j) {
                IAudioSessionControl* control = NULL;
                IAudioSessionControl2* control2 = NULL;
                HRESULT got = IAudioSessionEnumerator_GetSession(sessions, j, &control);
                if (SUCCEEDED(got)) got = IAudioSessionControl_QueryInterface(control, &control_iid, (void**)&control2);
                DWORD pid = 0;
                if (SUCCEEDED(got)) got = IAudioSessionControl2_GetProcessId(control2, &pid);
                if (SUCCEEDED(got) && pid == GetCurrentProcessId()) {
                    AudioSessionState state;
                    got = IAudioSessionControl_GetState(control, &state);
                    if (SUCCEEDED(got) && state == AudioSessionStateExpired) {
                        IAudioSessionControl2_Release(control2);
                        IAudioSessionControl_Release(control);
                        continue;
                    }
                    if (SUCCEEDED(got)) got = IAudioSessionControl_SetDisplayName(control, wide, NULL);
                    if (SUCCEEDED(got)) {
                        if (retained) IAudioSessionControl_Release(retained);
                        retained = control;
                        control = NULL;
                    }
                    outcome = got;
                    if (FAILED(got)) naming_failure = got;
                }
                if (control2) IAudioSessionControl2_Release(control2);
                if (control) IAudioSessionControl_Release(control);
            }
            if (sessions) IAudioSessionEnumerator_Release(sessions);
            if (manager) IAudioSessionManager2_Release(manager);
            if (device) IMMDevice_Release(device);
        }
        if (SUCCEEDED(hr)) hr = FAILED(naming_failure) ? naming_failure : outcome;
        IMMDeviceCollection_Release(devices);
    }
    IMMDeviceEnumerator_Release(enumerator);
    return hr;
}

void ps_identity_close(void)
{
    if (retained) { IAudioSessionControl_Release(retained); retained = NULL; }
    if (initialized) { CoUninitialize(); initialized = 0; }
}
#else
int32_t ps_identity_set(const char* name) { (void)name; return 0; }
void ps_identity_close(void) {}
#endif
