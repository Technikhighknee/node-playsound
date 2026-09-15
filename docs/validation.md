# Release candidate validation

[Documentation](../README.md#documentation) · [API reference](api.md)

## Published 0.1.0 compatibility finding

On 2026-09-16, the npm Windows x64 helper crashed before `READY` on an AMD
Ryzen 5 5600X with `0xC000001D`. A debugger located an AVX-512 instruction in
the distributed executable. The same file played with the baseline-built
helper. The published binary and locally tested binary had different hashes;
CI had tested its own CPU-specific build on a CPU that supported it.

The earlier successful matrix below therefore does **not** establish CPU
portability of 0.1.0. The corrective source explicitly selects a baseline and
rejects globally enabled AVX features in x64 builds. A new npm release is
needed to replace the defective distributed build.

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
