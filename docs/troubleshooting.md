# Troubleshooting

## The system mixer shows an unexpected application name

The default label is the entry-point filename. Use a `Player` with
`applicationName` for a product name. WASAPI session-aware mixers and Linux
PulseAudio/PipeWire use that label. Core Audio, ALSA, legacy Windows backends,
and tools that identify executable processes have different limits; see
[application identity](identity.md). A label does not transfer audio ownership
from the isolated helper to Node.

`DEVICE_ERROR` with “Could not label the Windows audio session” means the system
session metadata operation failed, often during a device change. Playback fails
explicitly. Check that the device is still available, then start a new playback;
the player's next helper receives the same label. Include the numeric error code
when reporting a reproducible failure.

[Quickstart](../README.md) · [API reference](api.md#errors) · [Recipes](recipes.md)

Start with the error from `finished`, not a guessed audio backend setting:

```ts
import { play, AudioError } from 'node-playsound';

try {
  await play('./sound.mp3').finished;
} catch (error) {
  if (error instanceof AudioError) {
    console.error(error.code, error.message);
    console.error(error.cause);
  } else {
    throw error; // Invalid arguments and application bugs need fixing too.
  }
}
```

Use the stable `code` for program decisions. Messages include file context and
may change; do not parse them. Paths and causes can contain application details,
so redact them before posting public logs.

## The file cannot be opened

For `FILE_ERROR`, check the resolved path, permissions, and whether it names a
regular file. Relative strings start at `process.cwd()`, not the script's folder.
Use `new URL('./sound.wav', import.meta.url)` for module-relative assets.

A file can change after validation, so an open failure can also appear as
`DECODE_ERROR`. Keep it available until completion. Directories, pipes, HTTP
URLs, and buffers are not playback sources. A `file:` URL must be a `URL` object,
not a string containing a URL.

## The file exists but decoding fails

`DECODE_ERROR` means the bundled decoder could not open, read, or seek the audio.
Supported formats are WAV, MP3, and FLAC; changing a filename extension does not
convert its contents. A container or codec variant may still be unsupported or
malformed. Try a known-good file in one of the supported formats.

If failure follows a seek, also check whether the decoder can determine the
file's length and reach the requested position. Unknown length is an explicit
seek failure. Some damaged files end early instead of failing; successful
playback is not proof of file integrity. A decoder error affects that play only.

## No output device or audio session

`DEVICE_ERROR` means there is no usable output or the device stopped. Confirm
that the same user/session can play audio through the operating system's default
output. Check output selection, mute controls, and whether a device was disconnected.

On Linux, the process needs access to the system audio libraries and an audio
session or ALSA device. A desktop application's session is not automatically
available inside Docker, SSH, a service account, or a CI runner. Installing an
external media player is not a requirement or a fix for session access. The
production engine fails explicitly instead of silently using a null device.

After correcting the system problem, a new play may start a fresh engine. Do
not retry indefinitely when the machine has no audio output. An explicit
`Player.close()` is permanent; use a new player after closing one.

## Playback finishes but I hear nothing

A resolved `finished` promise means the engine consumed the samples, not that a
speaker was audible. Check the file itself, its gain, and the system's output
and application mixer. `volume: 0` intentionally plays silently.

Calling `stop()` or `close()` immediately after `play()` may cancel before any
sound starts. Seeking at or beyond the known end also finishes the play. The
[quickstart](../README.md#play-your-first-sound) awaits natural completion.

## It works locally but fails after deployment

For `ENGINE_ERROR`, check that the installed package still contains `dist` and
all of `bin` beside it. The OS must be able to execute the selected helper.
Bundlers and executable packagers must keep the helper as a real executable
file outside virtual archives; copying only the JavaScript is insufficient.

Check filesystem execute permissions and deployment policies such as a `noexec`
mount. Hardened/notarized macOS applications must include and sign the helper
as required by their own distribution process. Reinstall a damaged package;
do not configure an unrelated external player.

`UNSUPPORTED_PLATFORM` indicates an unsupported OS/CPU combination. Consult the
[support table](../README.md#support); Linux builds require glibc 2.35 or newer
and do not support Alpine/musl. This package is for Node, not browser bundles.

## Illegal CPU instruction on Windows

Exit status `3221225501` is Windows `0xC000001D` (illegal instruction). Version
0.1.0's Windows helper could require CPU features of the CI build machine and
crash on another CPU before audio starts. This is a binary-build defect, not
an error in the playback call or file. Reinstalling the same 0.1.0 archive does
not fix it; use a release containing the portable-CPU build fix. Newer source
also explains this status in the `ENGINE_ERROR` message.

## Limits, timeouts, and cleanup

| Symptom | What to check |
| --- | --- |
| `PLAYBACK_LIMIT` | The default 64 pending/active plays are all in use. Await completion, stop one, or choose an explicit limit up to 256. There is no automatic queue. |
| `PLAYER_CLOSED` | The player, or the player that created a reusable sound, was already closed. Create a new owner. |
| `TIMEOUT` | Startup, seek, or decoding did not finish within ten seconds, or stop exceeded two seconds. Check device responsiveness and file/storage access. |
| Node remains alive | Active playback keeps Node alive; the shared engine also has a 250 ms idle interval. Use an owned player and await `close()` for deterministic cleanup. |
| An unhandled rejection | Every playback needs an observed `finished` promise. A `void` expression by itself does not handle errors. |

An engine failure can reject several plays belonging to the same player. A new
play can recover with a fresh engine; blindly repeating the failing input is not
a recovery strategy. For forced worker termination and POSIX process records,
see [shutdown](api.md#shutdown).

## Report a reproducible issue

Open an [issue](https://github.com/Technikhighknee/node-playsound/issues) with the
package and Node versions, OS/architecture, error code and redacted message,
and a minimal script. State whether it reproduces with a known-good WAV and
whether it happens during startup, normal playback, seeking, or shutdown.
Include a small audio fixture only if you can share it publicly. CI and hardware
coverage are recorded in [validation](validation.md).


## Paused playback or unexpected timestamps

A paused playback retains its concurrency slot and native resources. Use `stop()`
or `Player.close()` when done; pausing is not cleanup. Brief audio already queued
in the mixer/device can remain audible after pause. `state` acknowledges native
control, not the instant a speaker becomes silent.

`getTiming()` reports the stream's mixer-consumed position, so it can lead audible
output, advance in blocks, and stay still during starvation. Do not extrapolate it
as an exact audio clock. A null snapshot means playback stopped/finished before
it could be sampled; a null duration means the decoder provided no usable length.
Observe query rejections and `finished`. Seeking still requires a known length.

If a UI stops updating while waiting for a query, check for a pending seek or
engine failure. There is no automatic polling. Queries and pause/resume requests
have bounded ten-second deadlines; stop and close retain their shorter cleanup
bounds. An old helper executable fails the protocol handshake: reinstall or rebuild
all native artifacts from the current source instead of mixing package versions.
