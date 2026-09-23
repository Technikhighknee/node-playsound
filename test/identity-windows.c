/* SPDX-License-Identifier: CC0-1.0 */
/* Independent observer: reads actual system session metadata by helper PID. */
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <stdio.h>
#include <stdlib.h>
#include "../native/identity.h"

int main(int argc, char** argv)
{
    if (argc != 3) return 2;
    char name[256];
    WCHAR expected[256];
    if (!ps_identity_decode(argv[2], name) || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, expected, 256)) return 2;
    DWORD wanted = (DWORD)strtoul(argv[1], NULL, 10);
    const GUID clsid = {0xbcde0395,0xe52f,0x467c,{0x8e,0x3d,0xc4,0x57,0x92,0x91,0x69,0x2e}};
    const GUID iid = {0xa95664d2,0x9614,0x4f35,{0xa7,0x46,0xde,0x8d,0xb6,0x36,0x17,0xe6}};
    const GUID manager_iid = {0x77aa99a0,0x1bd6,0x484f,{0x8b,0xc7,0x2c,0x65,0x4c,0x9a,0x9b,0x6f}};
    const GUID session_iid = {0xbfb7ff88,0x7239,0x4fc9,{0x8f,0xa2,0x07,0xc9,0x50,0xbe,0x9c,0x6d}};
    if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) return 3;
    IMMDeviceEnumerator* enumerator = NULL;
    IMMDeviceCollection* devices = NULL;
    int found = 0, failed = 0;
    HRESULT hr = CoCreateInstance(&clsid, NULL, CLSCTX_ALL, &iid, (void**)&enumerator);
    if (SUCCEEDED(hr)) hr = IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &devices);
    UINT count = 0;
    if (SUCCEEDED(hr)) hr = IMMDeviceCollection_GetCount(devices, &count);
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
            IAudioSessionControl2* session = NULL;
            HRESULT got = IAudioSessionEnumerator_GetSession(sessions, j, &control);
            if (SUCCEEDED(got)) got = IAudioSessionControl_QueryInterface(control, &session_iid, (void**)&session);
            DWORD pid = 0;
            if (SUCCEEDED(got)) got = IAudioSessionControl2_GetProcessId(session, &pid);
            if (SUCCEEDED(got) && pid == wanted) {
                WCHAR* actual = NULL;
                got = IAudioSessionControl_GetDisplayName(control, &actual);
                if (FAILED(got) || !actual || wcscmp(actual, expected)) failed = 1;
                else found++;
                CoTaskMemFree(actual);
            }
            if (session) IAudioSessionControl2_Release(session);
            if (control) IAudioSessionControl_Release(control);
        }
        if (sessions) IAudioSessionEnumerator_Release(sessions);
        if (manager) IAudioSessionManager2_Release(manager);
        if (device) IMMDevice_Release(device);
    }
    if (devices) IMMDeviceCollection_Release(devices);
    if (enumerator) IMMDeviceEnumerator_Release(enumerator);
    CoUninitialize();
    if (FAILED(hr) || failed || !found) return 1;
    printf("Verified %d Windows session label(s).\n", found);
    return 0;
}
