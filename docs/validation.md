# Release candidate validation

Recorded on 2026-09-14. This is an unpublished npm release candidate;
automated platform validation does not imply physical hardware validation.

[GitHub Actions run 34900194573](https://github.com/Technikhighknee/node-playsound/actions/runs/34900194573)
passed at commit `f02903deb8fe399e6c4542c7c47e62af307bfaf0`, including seeking
and the decoder-error/completion-race fix. All six native
jobs built and tested on their target operating system and architecture,
using both Node 22 and Node 24. The final package assembly and installation
checks also passed, producing the downloadable `npm-package` artifact.

| Check | Evidence |
| --- | --- |
| CI: Windows, macOS, Linux; x64 and ARM64 | All 55 tests pass on each target under Node 22 and Node 24 |
| Windows x64, Node 24.14.0 | Strict typecheck, build, and 55 tests pass locally |
| Real Windows output | MP3 and WAV device initialization/playback reach completion |
| Production Windows seeking | A five-second WAV sought to 4.5 seconds completes in under one second |
| Installed ESM consumer | Tarball installed with scripts disabled and no runtime dependencies |
| Baseline Windows-built archive on Linux | Installation preserves executable permissions; missing audio reports `DEVICE_ERROR` |
| Installed TypeScript consumer | Public imports, `seek(number): void`, and compile-time misuse checks pass |
| Native builds | All six targets compile and execute in CI |
| Archive | Source/binary hashes, target machine types, allowed files, and executable modes checked |

The native tests exercise two full batches of 256 simultaneous native
voices, capacity overflow, and successful playback after releasing all slots.
These tests passed on all six targets.

Seeking coverage includes streamed WAV/MP3/FLAC forward and backward seeks,
beyond-end completion, malformed protocol input, invalid arguments, pending
startup, 10,000 rapid requests, cancellation, shutdown, peer isolation, and
non-extendable seek/stop deadlines. Direct PCM tests verify that seeking moves
between silent and audible regions, and injected decoder seek/refill failures
verify explicit errors and voice destruction. Unknown-length seeking fails
explicitly as documented. Physical macOS/Linux seeking remains unverified.

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
