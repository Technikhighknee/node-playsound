# Development and release

Prerequisites: Node 22+, npm, and a C11 compiler. Windows builds use Zig 0.14.1
in CI; macOS uses the Xcode command-line compiler; Linux uses GCC. Compilers
are for maintainers only. End users install a prebuilt tarball.

```sh
npm ci --ignore-scripts
npm run build:native
npm run build:test-native
npm run check
npm run test:package -- --local
```

`CC` selects the compiler executable. `CFLAGS_JSON` is a JSON array of
additional arguments, never a shell command. To use an installed Zig compiler
from PowerShell:

```powershell
$env:CC = 'C:\path\to\zig.exe'
$env:CFLAGS_JSON = '["cc"]'
npm run build:native
npm run build:test-native
npm run check
```

`npm run test:unit` needs no native compiler or audio device. `npm test` runs
unit, process-transport, native decoder, PCM rendering, and lifecycle tests;
first build both native test executables with `build:test-native`. Rebuild
them after native changes. Tests verify build hashes and fail rather than
silently use a stale or missing engine. Generated WAVs and small CC0 MP3/FLAC
fixtures make tests offline.

`npm run test:device` plays a quiet test tone through the real default output;
use a desktop session with audio enabled. An optional filename can follow
`--`. Run this separately from deterministic, silent CI tests. It verifies
device initialization and completion; someone should also listen on each
supported platform before a public release.

## Distribution

The six-platform CI matrix builds and tests each native executable on its own
OS and CPU, runs Node 22 and 24 tests, and checks an installed tarball in a
separate consumer project with lifecycle scripts disabled. The final job
assembles all six executables, validates their source/binary hashes and
architectures, verifies exported types, then produces the `npm-package`
artifact. It does not publish automatically.

`npm run package` fails if any target is absent or stale. It preserves executable
permissions in the tarball even when run on Windows. Plain `npm pack` is
supported on Unix hosts; on Windows its guard directs you to `npm run package`.
`test:package -- --local`
is explicitly a local-install check, not a release-readiness assertion.
Release artifact files exclude tests, C source, toolchains, debug symbols,
and development dependencies. Source remains in Git, with miniaudio's license.

Before publishing:

1. Confirm ownership/availability of the npm name; set repository metadata
   once this repository has an actual remote. No author or remote is invented.
2. Set the version, update release notes, and require a green six-platform CI
   run for that exact commit. Do not mix artifacts from different commits.
3. Run/listen to real-device WAV/MP3/FLAC playback, overlapping sounds, volume,
   stop, and shutdown on Windows, macOS, and Linux. Record results.
4. Inspect the CI `.tgz` contents, license, API declarations, and installed
   consumer output. Publish that exact verified tarball using npm's usual
   account controls. Publishing is a separate maintainer action.

Linux binaries built on Ubuntu 22.04 target glibc 2.35+. Test audio on both
PulseAudio/PipeWire-compatible and ALSA setups. macOS builds set deployment
target 13.0. Executable permissions are restored after CI artifact transfer.
No code-signing identity is assumed; applications distributed with hardened
runtime/notarization requirements must include/sign the helper appropriately.
Bundlers and executable packagers must preserve `bin` beside `dist`, outside
any archive that the OS cannot execute directly.

## Vendor updates

The modified miniaudio header is pinned by SHA-256 in
`scripts/native-manifest.mjs`; upstream provenance and the local error-handling
fixes are recorded in `THIRD_PARTY_NOTICES.md`. Review upstream changes and
licenses, preserve or verify upstream replacements for those fixes, update the pin,
then rebuild and test all platforms. Never download code during installation.
