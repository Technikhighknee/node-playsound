# Changelog

## Unreleased

- Fix Windows native engines built with optional features of the CI host CPU,
  which could crash on other machines with `0xC000001D` before playback started.
  Native builds now select a portable CPU baseline, and x64 compilation rejects
  accidental AVX requirements.
- Explain illegal-instruction engine crashes while preserving `ENGINE_ERROR`.

## 0.1.0

Initial release:

- Local WAV, MP3, and FLAC playback with bundled Windows, macOS, and Linux
  executables for x64 and ARM64. No runtime npm dependencies or install-time builds.
- TypeScript and ESM API: `play`, reusable `sound`, and scoped `Player` ownership.
- Independent concurrent playback, volume, stop, absolute seeking, and completion
  through `finished`. AbortSignal and asynchronous disposal support.
- Bounded streaming buffers, reusable decoder workers, isolated native processes,
  explicit decoder/device errors, and bounded shutdown and operation timeouts.
- CC0-1.0; unmodified miniaudio under its public-domain option.

See [platform support](README.md#support), [API contracts](docs/api.md), and
[validation evidence](docs/validation.md) for limitations and tested environments.
