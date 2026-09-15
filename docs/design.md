# Design

The public abstraction is a playback, not an operating-system process.
A handle represents exactly one play; a sound is reusable path/configuration;
a player is the ownership and concurrency boundary.

## Why a bundled native executable

Node has no built-in cross-platform audio output or decoding API. Relying
on shell players transfers installation, codec, volume, and lifecycle
differences to the application. A native Node addon can avoid process IPC,
but introduces ABI/build distribution concerns and puts decoder failures in
the application's process.

We bundle miniaudio 0.11.23 in a small executable. It supplies WAV, MP3, and
FLAC decoding and native Windows/macOS/Linux device backends. There are no
runtime npm dependencies, postinstall builds, downloads, or external players.
All supported executables are included in a release tarball; the size tradeoff
buys offline installation and independence from optional-dependency behavior.
The helper is an isolation boundary, not a security sandbox.

One lazy engine per player owns one output mixer and up to 256 streaming
voices. The public default is 64 pending/active plays. Streaming bounds
decoded memory per voice rather than per file duration. Repeated sounds
reuse the engine and device; they deliberately do not retain an unbounded
decoded cache or promise zero-latency playback. The 250 ms idle interval
avoids process churn for nearby plays without keeping applications alive
indefinitely.

## Ownership and races

Only the native main thread initializes, starts, changes, and destroys voices.
An input thread feeds a single bounded mailbox. The engine's audio thread
does mixing; it never emits IPC or frees a sound from an end callback.
The main loop polls completion with a 5 ms sleep and destroys a voice before sending
its completion. Decoder status is checked separately from end-of-stream.

Node owns a bounded set of playback entries. Entry removal is the single
settlement gate; late completion, abort, and error messages become harmless.
Pending validation rechecks ownership and closure before creating any engine.
Volume updates are coalesced while the command channel is backpressured.
Commands have bounded length; response frames are limited to 256 characters,
queued commands to 40 MiB, and diagnostics to the last 2 KiB.

Stopping a play command still buffered in Node cancels it without creating a native
voice. Stop also removes that voice's unwritten seek and volume commands, even
when its play command has already been written. Bytes accepted by the pipe
cannot be recalled; those commands retain their order. Otherwise the engine
acknowledges destruction. A stuck stop fails the
engine after two seconds, so affected peers receive explicit failure instead
of continuing with uncertain state. Startup is bounded to ten seconds.
There is no arbitrary time limit on a successfully playing recording;
applications can impose one with an AbortSignal.

Normal close ends the command pipe and waits for process exit, with a
two-second kill fallback. A separate native watchdog watches the parent
process even if input is backpressured and file/device initialization blocks.
The watchdog uses a Windows process handle or the POSIX parent PID. An abrupt
exit relies on OS reclamation of file descriptors, threads, and device handles.
Explicit `close()` is still the deterministic ownership mechanism.
Native mailbox backpressure also has a ten-second limit, so a terminated Node
worker cannot strand a blocked engine indefinitely while its parent stays alive.
On POSIX, libuv in a forcibly terminated worker cannot reap an exited child;
the main Node process may retain its zombie process record. The native process
has released its resources, but cooperative `Player.close()` before worker
termination is required to reclaim the PID promptly as well. Tests distinguish
native execution ending from the process record being reaped.

The normal device backend must succeed. The silent/null backend is compiled
out of production. Tests build a separate executable with that backend and
a separate offline renderer; production selection cannot fall back to them.

## Limits of the abstraction

Audio devices and OS buffers are asynchronous. Completion means consumption
by the engine, not a guarantee that the final sample has left a physical
speaker. Volume is linear gain; mixing multiple full-volume files can clip.
Use lower gains when layering loud recordings. Device changes may fail active
plays rather than transparently migrating them.

There is no pause, network streaming, device selector, effects graph,
global volume, or scheduling API. Additions should justify their lifecycle
and portability costs. Codec support is explicit rather than delegated to
whatever software happens to be installed.

## Seeking

`Playback.seek(seconds)` follows volume's command/error model: no extra
promise or public event stream. The controller keeps one in-flight seek and
one latest pending target per voice. It dispatches after `STARTED`, bounds
each operation to ten seconds, and ignores late acknowledgments during stop
or close. The existing completion gate handles natural-end and failure races.

Protocol 2 adds `Q id seconds` and `SEEKED id`. Older helpers fail the startup
handshake instead of silently ignoring a new command. The native main thread
converts seconds using the decoded output sample rate, checks the cached length, and
ends beyond-end requests before any unsafe floating-point-to-integer cast.
Unknown lengths fail explicitly instead of guessing a boundary.

The unmodified miniaudio header supplies public `ma_decoder` and
`ma_data_source` APIs. Each voice owns a decoder and a 16,384-frame stereo
float PCM ring (128 KiB, independent of file duration). Two reusable workers
serve voices round-robin, with at most one job per decoder. Initial opening,
length discovery, and priming run on the main thread before registration;
subsequent reads and seeks run outside both the pool mutex and PCM lock.
Decoding converts to the engine sample rate, so seek targets and cached
lengths use that same frame domain.

The mixer only copies buffered PCM. It tries the PCM lock once and returns
`MA_BUSY` on contention, starvation, or a pending seek, allowing other voices
to keep mixing without disk access, allocation, or waiting. A seek clears the
buffer and advances a generation. A refill already running may finish, but
its stale samples and EOF are discarded; actual errors are never discarded.
Acknowledgment follows successful decoder seek and first refill, not command
submission. No private miniaudio fields or patched resource-manager behavior
are involved; the unused resource manager is compiled out.

This adds a small streaming implementation to maintain, with explicit tests
for its buffer and ownership rules. Decoding on the mixer would let slow I/O
stall every voice; a thread per voice would make thread counts scale with
concurrency. Intercepting resource-manager internals would preserve the vendor
coupling and incomplete error reporting that this design removes. The fixed
pool bounds threads and memory, though two blocked decoders can starve all
voices until timeout; it does not promise real-time disk performance.

Destruction first detaches the sound from the mixer, then removes the stream
from the pool and waits for its current job before freeing the decoder and
buffer. A decoder error destroys only its voice. A background job exceeding
ten seconds terminates the isolated helper with `TIMEOUT`; Node's existing
seek and two-second stop/close deadlines also bound stuck work. Safe in-process
cancellation of arbitrary decoder I/O is not assumed.

Position and duration are not exposed: buffered playback and device latency
make a synchronous cursor easy to misinterpret, and duration can be unknown.
The public feature remains a single `seek(seconds): void` method.

## Evidence

- [Miniaudio manual and platform backend/build information](https://miniaud.io/docs/manual/index.html)
- [Pinned upstream source](https://github.com/mackron/miniaudio/tree/0.11.23)
- [Node child-process lifecycle and pipe behavior](https://nodejs.org/api/child_process.html)

Source and executable checksums accompany every native release artifact.
The packaging gate verifies the target executable architecture, exact source
hash, binary hash, vendor pin, and zero-dependency contract before release.
