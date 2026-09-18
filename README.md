# node-playsound

[![npm version](https://img.shields.io/npm/v/node-playsound.svg)](https://www.npmjs.com/package/node-playsound)
[![Build and verify](https://github.com/Technikhighknee/node-playsound/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Technikhighknee/node-playsound/actions/workflows/ci.yml?query=branch%3Amaster)
[![License: CC0-1.0](https://img.shields.io/badge/license-CC0--1.0-blue.svg)](LICENSE)

Play local audio from Node.js with one import. TypeScript, ESM, and zero runtime
npm dependencies. WAV, MP3, and FLAC decoding is bundled for Windows, macOS, and
Linux—no external player, install-time compiler, or extra download.

## Play your first sound

Requires **Node.js 22 or newer** and a working audio output.

```sh
npm install node-playsound
```

Save this as `play.mjs`, put `sound.mp3` in your current directory, and run
`node play.mjs`:

```ts
import { play } from 'node-playsound';

await play('./sound.mp3').finished;
```

`play()` returns a handle immediately; file validation and playback start
asynchronously. **Observe `finished` on every playback.** It resolves to
`'ended'` or `'stopped'`, or rejects with an `AudioError` if playback fails.

## Control a playback

```ts
import { play } from 'node-playsound';

const playback = play('./music.flac', { volume: 0.5 });
playback.volume = 0.2;
playback.seek(80); // Absolute seconds from the beginning.
await playback.finished;
```

Call `await playback.stop()` to stop early and wait for cleanup. A playback is
one run of a file; seeking and volume affect only that run. Seeking is
asynchronous, and seeking at or past the known duration ends playback.
[See the complete seeking contract.](docs/api.md#seeking)

Pause an individual playback with `playback.pause()` and continue with
`playback.resume()`. Seeking while paused keeps it paused. To inspect progress,
`await playback.getTiming()` returns `{ position, duration }` in seconds, or
`null` if playback has settled. Duration can also be `null` when unknown.
Position means PCM consumed by the mixer, **not what is currently audible**.
[Pause and timing contracts](docs/api.md#pause-and-resume) explain acknowledgment,
query failures, and resource ownership.

## Play a sound more than once

```ts
import { sound } from 'node-playsound';

const notification = sound('./notification.wav', { volume: 0.3 });
await Promise.all([
  notification.play().finished,
  notification.play({ volume: 0.5 }).finished,
]);
```

The plays overlap and finish independently. A `Sound` retains a path and
settings; it does not preload the file. Each call reopens it and creates a
new playback. The audio engine is reused between nearby plays.

## Own playback in an application

Use a `Player` when a service, window, worker, or test needs to stop all of
its audio together:

```ts
import { Player } from 'node-playsound';

const audio = new Player();
try {
  await audio.play(new URL('./sound.mp3', import.meta.url)).finished;
} finally {
  await audio.close();
}
```

`close()` stops the player's pending and active sounds, waits for cleanup,
and permanently closes that player. Other players are independent.
Pass an `AbortSignal` to `play()` to tie a sound to an operation's cancellation.
[Recipes cover cancellation, background notifications, paths, and shutdown.](docs/recipes.md)

## Support

| System | Architectures | Audio output |
| --- | --- | --- |
| Windows 10/11 | x64; ARM64 on Windows 11 | System audio, normally WASAPI |
| macOS 13+ | Intel and Apple Silicon | Core Audio |
| Linux, glibc 2.35+ | x64 and ARM64 | PulseAudio/PipeWire compatibility or ALSA |

Only regular local files and `file:` URL objects are accepted. HTTP streams,
AAC/M4A, Ogg, browsers, Alpine/musl, and 32-bit systems are not supported.
Linux needs its system audio libraries and an accessible audio session;
headless containers often have neither. [Troubleshooting](docs/troubleshooting.md)
covers missing devices, paths, codecs, and bundled deployments.

Playback streams through bounded buffers. There is no unbounded decoded cache
or permanent background process. The default limit is 64 pending/active plays
per player; reaching it fails the new play rather than queuing it.

Volume is linear gain from `0` to `1`; overlapping loud recordings can clip.
Completion means the engine consumed the audio, so a little audio may remain
in device buffers. Gapless transitions,
and sample-accurate scheduling are not provided.

## Documentation

- [API reference](docs/api.md): every option, lifecycle rule, and error code.
- [Recipes](docs/recipes.md): common application patterns and runnable examples.
- [Troubleshooting](docs/troubleshooting.md): diagnose a failed or silent playback.
- [Design](docs/design.md): resource ownership, streaming, and process isolation.
- [Development](docs/development.md) · [Publishing](docs/publishing.md) · [Changelog](CHANGELOG.md).
- [Validation evidence](docs/validation.md): automated coverage and outstanding hardware checks.

CC0-1.0. Bundled miniaudio uses its public-domain option;
see [third-party notices](THIRD_PARTY_NOTICES.md).
