# Release candidate validation

Recorded on 2026-09-14. This is a local release candidate, not a published
package or a claim of completed hardware validation on all six targets.

| Check | Evidence |
| --- | --- |
| Windows x64, Node 24.14.0 | Strict typecheck, build, and 38 tests pass |
| Linux x64, Node 22.22.1 | Native decoding, PCM mixing, lifecycle, and pipe tests run under Ubuntu 22.04 userspace on WSL |
| Real Windows output | MP3 and WAV device initialization/playback reach completion |
| Installed ESM consumer | Tarball installed with scripts disabled and no runtime dependencies |
| Installed TypeScript consumer | Public imports and compile-time misuse checks pass |
| Native builds | Windows, Linux, macOS; x64 and ARM64 all compile |
| Archive | Source/binary hashes, target machine types, allowed files, and executable modes checked |

Local native builds use Zig 0.14.1. macOS builds were cross-compiled with the
macOS 13.3 SDK; they have not been executed on a Mac. The SDK and compiler
are not included in the package. Linux cross-builds target glibc 2.28;
the documented release baseline remains glibc 2.35 for the Ubuntu CI builds.

Before a public release, run the committed CI matrix on all six native
targets and complete real-device listening checks on Windows, macOS, and
Linux. macOS and ARM64 execution remain unverified locally. The repository
has no configured remote, so the GitHub workflow has not been dispatched.

The candidate is intentionally unpublished. Release steps and package-name
ownership checks are in [development.md](development.md).
