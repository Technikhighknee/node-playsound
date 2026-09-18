# API reference

[Quickstart](../README.md) · [Recipes](recipes.md) · [Troubleshooting](troubleshooting.md)

Use `play` for an individual sound, `sound` for reusable defaults, and `Player`
for an application-owned group. All are named exports from `node-playsound`.

```text
play(file: string | URL, options?: PlayOptions): Playback
sound(file: string | URL, options?: SoundOptions): Sound
new Player(options?: PlayerOptions)
```

`play` and `sound` use a shared, lazily opened player. A `Player` provides
the same `play` and `sound` methods, plus `close(): Promise<void>` and
`[Symbol.asyncDispose]()`. Construction and import perform no I/O.

## Files and paths

Paths resolve against `process.cwd()` when `play()` or `sound()` is called.
A `Sound` retains that absolute path even if the working directory changes.
A URL must use `file:`. No shell parses filenames; spaces, quotes, Unicode,
and newlines are encoded safely. Windows uses wide-character file APIs.
Symbolic links to regular files are allowed. Do not modify files during playback.

A string such as `"file:///tmp/tone.wav"` is a path string, not a URL; pass a `URL` object for
URL semantics. Relative paths refer to the working directory, not this module.
See [path examples](recipes.md#resolve-files-reliably).

## Options

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `volume` | `play`, `sound` | `1` | Finite linear gain between 0 and 1 |
| `signal` | `play` | none | AbortSignal; abortion stops this play |
| `maxConcurrent` | `Player` | `64` | Integer 1–256; includes pending and paused playback |

`sound(file, options).play(options)` takes the same playback options as
`play`. Per-play volume overrides the captured default. A sound is immutable
configuration, with no open file or device to dispose. Repeated calls share
the player's mixer, not the playhead. Each play can be stopped independently.
There is no implicit queue when the concurrency limit is reached.

## Player and Sound

| Member | Behavior |
| --- | --- |
| `new Player(options?)` | Creates an independent owner; opens no device or process yet |
| `player.play(file, options?)` | Creates one playback owned by this player |
| `player.sound(file, options?)` | Captures a path and defaults for plays owned by this player |
| `player.close()` | Returns `Promise<void>`; waits for cleanup and permanently closes the player |
| `player[Symbol.asyncDispose]()` | Equivalent to `close()` |
| `sound.play(options?)` | Creates a new independent playback on its original player |

Top-level `play` and `sound` share the default player and its concurrency limit.
There is no global close function; use an explicit `Player` for deterministic
shutdown. A `Sound` outliving its player cannot reopen it: its next play rejects
with `PLAYER_CLOSED`. `close()` releases resources; it does not replace observing
each playback's `finished` promise for errors.

## Playback

| Member | Contract |
| --- | --- |
| `finished` | `Promise<'ended' \| 'stopped'>`; rejects with `AudioError` on failure |
| `state` | Read-only: `pending`, `playing`, `paused`, `stopping`, `ended`, `stopped`, or `failed` |
| `volume` | Read/write gain; applies to this play only |
| `stop()` | Idempotent; returns the same promise as `finished` |
| `seek(seconds)` | Requests an absolute position; returns `void`; failures reject `finished` |
| `pause()` / `resume()` | Idempotent requests; return `void`; failures reject `finished` |
| `getTiming()` | `Promise<PlaybackTiming \| null>`; an on-demand native snapshot, or null after settlement |
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
import { play } from 'node-playsound';

const playback = play('./track.mp3');
playback.seek(80); // Absolute seconds from the beginning; fractions are allowed.
await playback.finished;
```

Seeking changes only this playhead, preserving volume, cancellation, and pause state.
Seeking while paused does not resume playback. It
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
  fails that playback with `DECODE_ERROR`. A stuck seek or background decoder
  operation fails its engine after ten seconds with `TIMEOUT`, rejecting its other active plays too. Device and
  process failures retain their existing error codes and scope.

Positions are converted to whole PCM frames at the engine sample rate. Decoding
and output buffering can introduce a short delay, silence, or buffered audio from the
old position. Stop removes unwritten seek commands from Node's queue; a seek
already written to the pipe may run before the stop is processed.
There is no sample-accurate or gapless-seeking guarantee.
MP3 seeking may require decoding earlier frames and can be slower on long files.
Use `getTiming()` to sample the mixer-consumed position after a seek completes.

### Pause and resume

`pause()` requests that this voice stop consuming PCM; `resume()` requests that it
continue from that position. Both return `void`, like `seek()`. Repeated requests
for the same state are harmless. Rapid transitions retain one in-flight transition
and the latest requested state; intermediate transitions may be skipped. `state`
changes to `paused` or `playing` only after acknowledgment. Until startup is
acknowledged it remains `pending`, even if pause has already been requested.

A pause made synchronously after `play()` is included in the initial play command,
so the voice starts paused. After dispatch, some audio may already be buffered;
pause cannot retract it. Resume never rewinds. Paused voices retain their buffer,
decoder, device, and concurrency slot, and keep Node alive. Always stop or close
playbacks that will not be resumed. Decoding may fill the bounded buffer while
paused, then stops until space is freed or seeking is requested.

Pause and resume after stopping, settlement, or closure do nothing. EOF, failure,
and cancellation can win a race with either command. A seek at/beyond known duration
ends even a paused playback. A paused voice can still fail on decoder/device/engine
errors. A stuck transition fails the isolated engine after ten seconds; repeated
requests cannot extend that deadline. Stop/abort/close remain bounded as before.

### Position and duration

```text
interface PlaybackTiming {
  readonly position: number;
  readonly duration: number | null;
}
playback.getTiming(): Promise<PlaybackTiming | null>
```

`getTiming()` queries a snapshot, without background polling or wall-clock
extrapolation. It waits for startup and outstanding seek/pause/resume operations.
Overlapping calls share one promise and one immutable snapshot. Once that query
has entered the pipe, later commands may occur after its snapshot. To observe a
later command, await the earlier query, issue the command, then query again.

- **Position** is absolute seconds of PCM handed from the stream buffer to the
  mixer, including the seek offset. It is not the decoder's read-ahead cursor,
  elapsed wall time, or the timestamp currently audible at the speaker.
- It advances in mixer blocks, stays stable during pause and decoder starvation,
  and jumps on seek. Without seeking it is nondecreasing. Conversion uses the
  engine sample rate; fractional seconds do not imply sample-accurate delivery.
  A snapshot may already be old when its promise resolves while playing.
- **Duration** is decoder-reported output frames divided by the output sample
  rate. WAV, MP3, and FLAC ordinarily supply it. `null` explicitly means no usable
  length is available (including a decoder reporting zero); it is never estimated
  from buffered data. It is not a promise of physical-device playback duration.
- If normal completion, stop, abort, or close wins, the query resolves `null`.
  Queries made after settlement or while stopping also resolve `null`. The library
  does not invent a final position after losing an engine.
- Pending queries reject on failure, as does `finished`. Observe **both** promises.
  A query has a ten-second deadline, including time waiting for earlier controls.
  Repeated calls cannot postpone it. Timeout fails all plays in that engine.

A serial UI refresh loop can choose its own frequency (for example 250 ms).
Do not launch an unbounded set of promise handlers or treat these snapshots as
an audio/video synchronization clock. See the [pause recipe](recipes.md#pause-and-inspect-a-playback).

## Cancellation

Cancellation is a request to stop, not a decoder error. A timeout signal resolves
playback to `stopped`; the library's own operation timeout rejects with `TIMEOUT`.

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
| `TIMEOUT` | Startup, a seek, or background decoding exceeded 10 seconds, or stopping exceeded 2 seconds |

A file can change between Node's validation and the native open. Such
failures may surface as `DECODE_ERROR`. Valid empty/truncated files may fail
or end early depending on what their decoder can recover. Playback is not
a file-integrity validator. Engine-wide failures reject all plays owned by
that engine. A single decoder failure does not cancel other sounds.

## TypeScript

Types ship with the package; no separate `@types` package is needed. Public
exports include `AudioFile`, `Playback`, `PlaybackResult`, `PlaybackState`,
`PlayOptions`, `Sound`, `SoundOptions`, `PlayerOptions`, and `AudioErrorCode`.
Import types with `import type`. Use an ESM project with TypeScript's `NodeNext`
module settings, or a `.mts` source file. Plain JavaScript examples use `.mjs`.

```ts
import { play, type Playback, type PlaybackResult } from 'node-playsound';

const playback: Playback = play('./tone.wav');
const result: PlaybackResult = await playback.finished;
console.log(result);
```

Both `Player` and `Playback` implement `AsyncDisposable`. With TypeScript,
`await using` requires `ESNext.Disposable` in `lib` (or a library target that
includes it). When running JavaScript directly, your Node version must support
the syntax. The `try`/`finally` examples work across the supported Node range.
Disposing a playback awaits `stop()` and can reject if playback failed.
