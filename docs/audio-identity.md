# Application identity in system audio controls

## Design

Audio remains owned by the isolated helper process. A display label is not a
transfer of process ownership, permission, routing, or capture identity.

The proposed additive API is `new Player({ applicationName: 'My application' })`.
Without an override, use the entry-point filename (including its extension),
or the executable filename when there is no entry point. Capture the name at
player construction; retain it across helper restarts. Do not search package
metadata, inherit npm's potentially unrelated package name, or expose full paths
and command-line arguments. Import and construction still perform no I/O.
Names must be nonblank Unicode, without control characters, and at most 255
UTF-8 bytes. Invalid explicit values fail synchronously. Unusable inferred names
fall back to `Node.js`.

Pass the bounded name as a hex-encoded helper argument, not a shell command or
mutable ambient environment variable. A helper cannot start without understanding
the new startup contract. Playback commands and their ordering remain unchanged.

### Windows

Use the documented Core Audio session display name. Query sessions using public
Windows COM interfaces and match the helper's PID; never modify another process's
session. Apply before playback becomes available and after WASAPI rerouting.
All COM work runs on the helper main thread, not the audio callback. Release all
interfaces on that thread. Naming failures on the supported WASAPI path are
reported as device failures, not silently ignored. Retain existing fallback
backends; their presentation is controlled by Windows and is not guaranteed.

### Linux

Set both PulseAudio application and playback stream names through public miniaudio
configuration. This also covers PipeWire's PulseAudio compatibility server. ALSA
does not provide an equivalent per-application mixer label; do not pretend it does.

### macOS

Core Audio attributes audio to the process that owns its audio unit. Its process
PID/bundle identity is not a display-name setting. The helper remains visible in
process-based tools. Do not copy/rename executables, fabricate application bundles,
use private responsibility APIs, or replace isolation with an in-process addon
just to change an apparent name. An application label cannot promise parent-process
attribution on macOS. The option is accepted portably but cannot override this.

### Ownership and validation

Explicit device ownership allows setting the PulseAudio stream label. Initialize
the device stopped, initialize the engine against it, apply identity, then start.
Stop the device before destroying the engine; destroy the device before its
context. No per-play identity state, polling, queue, worker, or timer is needed.
Reroute notifications only set an atomic flag for main-thread work.

Tests must cover name inference/validation, argument encoding, startup rejection,
independent players and restarts, and the existing native/lifecycle suite. Verify
real Windows session metadata and PulseAudio metadata where an audio server is
available; null-backend tests alone cannot establish OS presentation.

## Platform references

- [Windows session display names](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol-setdisplayname)
- [PulseAudio application properties](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/Clients/ApplicationProperties/)
- [Core Audio process identity](https://developer.apple.com/documentation/coreaudio/kaudioprocesspropertypid)
- [Pinned public miniaudio API](https://github.com/mackron/miniaudio/blob/0.11.23/miniaudio.h)
