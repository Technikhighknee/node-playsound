# node-playsound

Play local audio from Node.js. TypeScript, ESM, zero runtime dependencies.
WAV, MP3, and FLAC decoding and playback are bundled—no external player,
compiler, installation script, or extra download on the user's machine.

> Pre-release source. This repository has not been published. Install the
> verified `.tgz` produced by CI; see [release instructions](docs/development.md).

```sh
npm install ./node-playsound-0.1.0.tgz
```

```ts
import { play } from 'node-playsound';

await play('./sound.mp3').finished;
```

`play()` starts immediately and returns a handle. Always await or catch
`finished`: file, decoder, and device failures reject with `AudioError`.

```ts
const playback = play('./music.flac', { volume: 0.5 });
playback.volume = 0.2;
await playback.stop();
// finished resolves to 'ended' or 'stopped'.
```

Reuse a sound, including concurrent plays:

```ts
import { sound } from 'node-playsound';

const notification = sound('./notification.wav', { volume: 0.7 });
await Promise.all([
  notification.play().finished,
  notification.play({ volume: 0.3 }).finished,
]);
```

For an application-owned group, use a `Player`. Closing it stops its sounds
and releases its resources. Other players are independent.

```ts
import { Player } from 'node-playsound';

const audio = new Player();
try {
  await audio.play(new URL('./sound.mp3', import.meta.url)).finished;
} finally {
  await audio.close();
}
```

`Player` and playback handles also support `await using`. Pass an
`AbortSignal` to `play()` to stop with your application's cancellation scope.

## Support

Node.js 22+; ESM imports. Release builds target:

| System | Architectures | Audio output |
| --- | --- | --- |
| Windows 10/11 | x64; ARM64 on Windows 11 | System audio, normally WASAPI |
| macOS 13+ | Intel and Apple Silicon | Core Audio |
| Linux, glibc 2.35+ | x64 and ARM64 | PulseAudio/PipeWire compatibility or ALSA |

Linux needs a working audio session and its system audio libraries. Bare
containers and headless servers often have no audio output; they fail with
`DEVICE_ERROR`. Alpine/musl, 32-bit systems, AAC/M4A, Ogg, URLs, and browser
playback are not supported. Files must be regular local files.

The engine opens lazily, shares one mixer per player, streams active files,
and closes after 250 ms idle. It creates no permanent process or exit hook.
There is no unbounded decoded-audio cache. A reusable sound captures the path
and defaults; subsequent plays reopen the file.

Volume is linear, from `0` to `1`, and affects only that playback. Completion
means the engine consumed the sound; a small amount of audio can remain in
the operating system's output buffer. This is not a sample-accurate scheduler.

[API and errors](docs/api.md) · [Design and lifecycle](docs/design.md) ·
[Development and release](docs/development.md) · [Examples](examples/)

CC0-1.0. Bundled miniaudio uses its public-domain option; see
[third-party notices](THIRD_PARTY_NOTICES.md).
