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

Stopping a command still buffered in Node cancels it without creating a native
voice. Otherwise the engine acknowledges destruction. A stuck stop fails the
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
converts seconds using the source sample rate, checks the cached length, and
ends beyond-end requests before any unsafe floating-point-to-integer cast.
Unknown lengths fail explicitly instead of guessing a boundary.

The sound API atomically publishes the target to miniaudio's mixing thread,
which posts the streamed seek to its decoder job thread. Acknowledgment waits
for both the sound's pending target and the stream's seek counter to clear;
it is not emitted just because the public C seek function returned. This uses
two internal atomic fields of the pinned vendor version and must be reviewed
on upgrades. Serial dispatch prevents that version's load/store handling of
the target from losing a newer request. No Node callback runs on an audio thread.

Three documented vendor fixes surface seek submission, decoder seek, and
refill errors through the existing stream status. Their failure paths have
direct native tests. A decoder failure destroys only that voice; a timeout
retires the entire isolated helper as before. The cursor API reports requested
positions before asynchronous decoding completes, and duration can be unknown;
neither is exposed as misleading synchronous playback metadata.

## Evidence

- [Miniaudio manual and platform backend/build information](https://miniaud.io/docs/manual/index.html)
- [Pinned upstream source](https://github.com/mackron/miniaudio/tree/0.11.23)
- [Node child-process lifecycle and pipe behavior](https://nodejs.org/api/child_process.html)

Source and executable checksums accompany every native release artifact.
The packaging gate verifies the target executable architecture, exact source
hash, binary hash, vendor pin, and zero-dependency contract before release.
