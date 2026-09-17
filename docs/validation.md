# Release candidate validation

[Documentation](../README.md#documentation) · [API reference](api.md)

## Pause and timing validation (2026-09-17)

The unpublished pause/timing change is tracked in [PR #6](https://github.com/Technikhighknee/node-playsound/pull/6).
Use its [checks](https://github.com/Technikhighknee/node-playsound/pull/6/checks)
for the exact tested commit and downloadable artifacts. Protocol 3 requires all
helpers to be rebuilt together; published 0.1.2 does not contain these features.

Local Windows x64 / Node 24.14.0 validation includes strict typecheck, the full
suite, documentation compilation/link checks, production-device checks, and an
installed ESM/TypeScript consumer with scripts disabled and no runtime dependencies.
The expanded suite has 104 tests; the offline pause renderer and paused-worker
teardown also run in the Linux ASan/UBSan/leak-detection job. CI runs the suite on
Windows, macOS, and Linux, x64 and ARM64, under Node 22 and 24, then verifies the
complete six-engine archive and publication dry-run. Refer to the linked checks
rather than treating the existence of a workflow as evidence of success.

New coverage includes:

- Pause before dispatch and after startup, repeated pause/resume, retained
  concurrency capacity, and 256-voice batches including initially paused voices.
- Exact offline mixer-consumed positions, pause stability, resume advancement,
  forward/backward seeking while paused, and independent concurrent voices.
- WAV/MP3/FLAC duration and natural completion, explicit unknown duration,
  beyond-end seeking while paused, starvation, and frame-counter overflow.
- Shared queries, startup/seek barriers, pause around in-flight seek, stale tokens,
  retired engine callbacks, malformed responses, and fixed operation deadlines.
- Stop/abort/close/failure while paused; real OS-pipe backpressure removes unwritten
  seek/pause/timing commands without discarding peers' commands.
- Decoder failure while paused, bounded refilling, and destruction waiting for
  a blocked worker before releasing a paused stream's memory.

The production Windows device backend passed WAV/MP3/FLAC paused startup,
known duration, seek while paused, stable snapshots, resume, and completion.
The longer WAV also verified pause after position had advanced. Physical-speaker
accuracy is intentionally not claimed; no timing API can retract device buffers.
Physical macOS/Linux listening remains unverified and is separate from CI's
silent-backend and offline PCM evidence.

Hostile review tightened EOF races (public node-state resume cannot rewind an
ended sound), added seek acknowledgment tokens, fenced retired engine callbacks,
and rejected frame-counter overflow. Queries neither read decoders nor allocate,
block, or write IPC in the callback. Tests verify worker ownership and stale PCM
separately from the timing snapshot. Vendored miniaudio remains unmodified.

## Published 0.1.0 compatibility finding

On 2026-09-16, the npm Windows x64 helper crashed before `READY` on an AMD
Ryzen 5 5600X with `0xC000001D`. A debugger located an AVX-512 instruction in
the distributed executable. The same file played with the baseline-built
helper. The published binary and locally tested binary had different hashes;
CI had tested its own CPU-specific build on a CPU that supported it.

The earlier successful matrix below therefore does **not** establish CPU
portability of 0.1.0. The corrective source explicitly selects a baseline and
rejects globally enabled AVX features in x64 builds. Version 0.1.1 contains
the corrective build settings.

## 0.1.1 fix validation

[CI run 35029136651](https://github.com/Technikhighknee/node-playsound/actions/runs/35029136651)
passed for fix commit `56ffb3b5c69200cabd9f411804f9a66cc9e6c86a`: all six target
platforms on Node 22 and 24, 65 tests, sanitizers, documentation checks, and
complete package installation/publication dry-run checks.

The actual CI-built Windows x64 artifact was downloaded and verified against
its source and binary manifests, then run on the affected Ryzen 5600X. Startup,
playback, seeking to 80 seconds, and stopping passed. Its SHA-256 was
`b9efe02000237af4b2054767b66a8fc08c7e5bc7a4f40ce8ec8986d079cc90ef`.
The unchanged consumer example also played its MP3 to natural completion with
the locally rebuilt baseline helper. An intentionally AVX-512-targeted build
was rejected by the compilation guard.

## Earlier validation record

Recorded on 2026-09-15. This is an unpublished npm release candidate;
automated platform validation does not imply physical hardware validation.

The public-decoder streaming rewrite and stop/backpressure regression tests
are tracked in [GitHub Actions run 34956963785](https://github.com/Technikhighknee/node-playsound/actions/runs/34956963785)
at commit `6e8cb75ed3c77f621e14752f526a050e8b3cb84c`. The workflow builds and
tests on all six target operating systems and architectures under Node 22
and Node 24, then assembles and installs the complete package. A separate
Linux job checks native PCM and concurrent buffer ownership with AddressSanitizer,
UndefinedBehaviorSanitizer, and leak detection. Consult the linked job results;
a release requires all checks green for its exact commit.

| Check | Evidence |
| --- | --- |
| CI: Windows, macOS, Linux; x64 and ARM64 | 64-test suite under Node 22 and Node 24; see linked CI results |
| Windows x64, Node 24.14.0 | Strict typecheck, build, and 64 tests pass locally |
| Real Windows output | WAV, MP3, and FLAC device playback reach completion |
| Production Windows seeking | A five-second WAV sought to 4.5 seconds completes in under one second |
| Installed ESM consumer | Tarball installed with scripts disabled and no runtime dependencies |
| Baseline Windows-built archive on Linux | Installation preserves executable permissions; missing audio reports `DEVICE_ERROR` |
| Installed TypeScript consumer | Public imports, `seek(number): void`, and compile-time misuse checks pass |
| Native builds | All six targets cross-compile locally; CI executes native target builds |
| Archive | Source/binary hashes, target machine types, allowed files, and executable modes checked |

The native tests exercise two full batches of 256 simultaneous native
voices, capacity overflow, and successful playback after releasing all slots.
Capacity and reuse are exercised on each CI target.

Seeking coverage includes streamed WAV/MP3/FLAC forward and backward seeks,
beyond-end completion, malformed protocol input, invalid arguments, pending
startup, 10,000 rapid requests, cancellation, shutdown, peer isolation, and
non-extendable seek/stop deadlines. Direct PCM tests verify that seeking moves
between silent and audible regions, and injected decoder seek/refill failures
verify explicit errors and voice destruction. Unknown-length seeking fails
explicitly as documented. Physical macOS/Linux seeking remains unverified.

The header checksum matches unmodified miniaudio 0.11.23. Buffer tests compare
all decoded samples against an independent decoder across wrap-around and
sample-rate conversion. They block one worker while its peer continues,
seek during the blocked refill, preserve stale-generation decoder errors,
and hold destruction until the outstanding job releases ownership. A stalled
background job is verified to exit with an explicit timeout. The transport
regression pauses child input and fills the OS pipe before queuing seek and
stop; it checks that the stopped voice's seek is removed and its peer's survives.

Forced worker termination ends native execution, including a blocked decoder.
On Linux, the exited process can remain a zombie under the surviving Node
parent. Cooperative worker shutdown is separately tested to reap it; see
[the lifecycle contract](api.md#shutdown).

Local native builds use Zig 0.14.1. Local macOS builds were cross-compiled
with the macOS 13.3 SDK; CI builds were built and executed on macOS runners.
The SDK and compiler are not included in the package. Linux cross-builds target glibc 2.28;
the documented release baseline remains glibc 2.35 for the Ubuntu CI builds.

The automated playback tests use a test-only silent backend and direct PCM
rendering. Production binaries separately pass installation/execution checks
and reject that test backend. Before a public npm release, complete physical
listening checks on macOS and Linux; those remain unverified. Windows device
playback has been checked locally. Re-run CI whenever implementation changes.

The candidate is intentionally unpublished. Release steps and package-name
ownership checks are in [development.md](development.md).
