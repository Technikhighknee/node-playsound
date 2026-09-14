# API

```ts
play(file: string | URL, options?: PlayOptions): Playback
sound(file: string | URL, options?: SoundOptions): Sound
new Player(options?: PlayerOptions)
```

`play` and `sound` use a shared, lazily opened player. A `Player` provides
the same `play` and `sound` methods, plus `close(): Promise<void>` and
`[Symbol.asyncDispose]()`. Construction and import perform no I/O.

Paths resolve against `process.cwd()` when `play()` or `sound()` is called.
A `Sound` retains that absolute path even if the working directory changes.
A URL must use `file:`. No shell parses filenames; spaces, quotes, Unicode,
and newlines are encoded safely. Windows uses wide-character file APIs.
Symbolic links to regular files are allowed. Do not modify files during playback.

## Options

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `volume` | `play`, `sound` | `1` | Finite linear gain between 0 and 1 |
| `signal` | `play` | none | AbortSignal; abortion stops this play |
| `maxConcurrent` | `Player` | `64` | Integer 1–256; includes pending playback |

`sound(file, options).play(options)` takes the same playback options as
`play`. Per-play volume overrides the captured default. A sound is immutable
configuration, with no open file or device to dispose. Repeated calls share
the player's mixer, not the playhead. Each play can be stopped independently.
There is no implicit queue when the concurrency limit is reached.

## Playback

| Member | Contract |
| --- | --- |
| `finished` | `Promise<'ended' \| 'stopped'>`; rejects with `AudioError` on failure |
| `state` | Read-only: `pending`, `playing`, `stopping`, `ended`, `stopped`, or `failed` |
| `volume` | Read/write gain; applies to this play only |
| `stop()` | Idempotent; returns the same promise as `finished` |
| `seek(seconds)` | Requests an absolute position; returns `void`; failures reject `finished` |
| `[Symbol.asyncDispose]()` | Stops and awaits completion |

`pending` includes file validation and engine startup. `playing` means the
engine accepted and started the sound, not that the first sample has reached
the speaker. Stop-before-dispatch creates no voice. Stop-after-dispatch waits
for acknowledgment. A simultaneous natural end may win the race and return
`ended`; it is never retroactively changed to `stopped`.

A pre-aborted signal resolves to `stopped` without file or device access.
Signal listeners are removed when the playback settles. Abortion does not
reject with `AbortError`; actual failures do reject. Valid volume assignments
after completion are harmless; invalid values always throw. `stop()` after
failure returns the already-rejected completion promise.

Always observe `finished`. Ignoring a rejected completion promise follows
Node's ordinary unhandled-rejection behavior; the library does not silently
discard audio failures or add global rejection handlers.

### Seeking

```ts
const playback = play('./track.mp3');
playback.seek(80); // Absolute seconds from the beginning; fractions are allowed.
await playback.finished;
```

Seeking changes only this playhead, preserving volume and cancellation. It
does not create a new playback or change `finished`. The operation is
asynchronous; `seek()` does not acknowledge audible arrival at the target.
Keep observing `finished` for errors, as with volume changes.

- Positions must be finite, nonnegative numbers; invalid values always throw
  `RangeError`, even after completion. Zero seeks to the beginning.
- Before startup finishes, the latest target is retained and sent when the
  engine starts the voice. Some initial audio may play before it takes effect;
  this is not a scheduled start-offset API.
- At most one seek per playback is in flight. Further requests replace a
  single pending target. Intermediate positions may be skipped; an in-flight
  seek is not interrupted. Repeated requests cannot extend its ten-second deadline.
- At or beyond the known duration, seeking ends that playback and resolves
  `finished` with `ended`. Natural completion can win a race with seeking,
  including a newer request; seeking never revives a completed voice.
- After stopping begins, completion, failure, or player closure, valid seeks
  have no effect. Stop, abort, and close retain their existing behavior and deadlines.
- Streamed WAV, MP3, and FLAC support seeking when their decoder supplies a
  known length and supports the target. Unknown length or a failed seek/refill
  fails that playback with `DECODE_ERROR`. A stuck seek fails its engine after
  ten seconds with `TIMEOUT`, rejecting its other active plays too. Device and
  process failures retain their existing error codes and scope.

Positions are converted to whole source PCM frames. Decoding and output
buffering can introduce a short delay, silence, or buffered audio from the
old position. There is no sample-accurate or gapless-seeking guarantee.
MP3 seeking may require decoding earlier frames and can be slower on long files.
Position and duration getters are deliberately absent: the decoder cursor can
lead audible output, and some streams have no reliable length.

```ts
import { play, AudioError } from 'node-playsound';

try {
  const result = await play('./message.mp3', {
    signal: AbortSignal.timeout(5_000),
  }).finished;
  console.log(result); // 'ended' or 'stopped'
} catch (error) {
  if (error instanceof AudioError) console.error(error.code, error.message);
  else throw error;
}
```

## Shutdown

`await player.close()` stops pending and active playback and waits for the
engine process to exit. It is idempotent and permanently closes the player.
Later calls to `play()` reject through `finished` with `PLAYER_CLOSED`.
Closing an unused player starts no process. A player can recover from an
engine failure on its next play, but cannot recover from explicit closure.

Active playback keeps Node alive. Idle engines close automatically after
250 ms; explicit `close()` avoids that idle interval. A normal shutdown can
take up to two seconds if the native engine is unresponsive before it is
forcefully terminated. Parent death also terminates the engine independently
of the command pipe. No process-wide signal handlers are installed.

For service shutdown, keep an application-owned `Player` and call `close()`
from your existing shutdown procedure. With worker threads, use an explicit
`Player` and await `close()` inside the worker before terminating it. Forced
worker termination still stops native execution (within ten seconds if the
decoder is blocked), but on POSIX Node can retain the exited child's process
record until the main process exits. Cooperative shutdown avoids that zombie
process record. Each worker otherwise has its own shared player.

## Errors

Invalid arguments throw `TypeError` or `RangeError` synchronously. Operational
failures reject `finished` with an `AudioError`, a stable `code`, a readable
message, and a `cause` chain where available. Do not parse message text.

| Code | Meaning / action |
| --- | --- |
| `FILE_ERROR` | Missing, unreadable, or non-regular file; check the path and permissions |
| `DECODE_ERROR` | Decoder could not open/read/seek the audio, or seeking has no known length |
| `DEVICE_ERROR` | No usable audio session/device, or device stopped; check system audio |
| `ENGINE_ERROR` | Missing executable, permissions, process failure, or protocol failure; reinstall/check deployment |
| `UNSUPPORTED_PLATFORM` | No bundled executable for this OS/architecture |
| `PLAYBACK_LIMIT` | Wait for or stop a play, or deliberately increase the player's limit |
| `PLAYER_CLOSED` | Construct a new player |
| `TIMEOUT` | Startup or a seek exceeded 10 seconds, or stopping exceeded 2 seconds |

A file can change between Node's validation and the native open. Such
failures may surface as `DECODE_ERROR`. Valid empty/truncated files may fail
or end early depending on what their decoder can recover. Playback is not
a file-integrity validator. Engine-wide failures reject all plays owned by
that engine. A single decoder failure does not cancel other sounds.
