# Third-party code

The native playback executable incorporates miniaudio 0.11.23 by David Reid
and its embedded WAV, MP3, and FLAC decoders. We use its public-domain option.
The original license statements remain in `native/vendor/miniaudio.h`.

Source: https://github.com/mackron/miniaudio/tree/0.11.23

Upstream unmodified header SHA-256:
`7e4f3f13c8fe66df2080ac3dd12a89193e3c2463cb7f067c798abd7331cd8ee6`

The vendored header is unmodified. Its checksum is pinned in
`scripts/native-manifest.mjs`. Streaming uses public decoder and data-source
APIs; no vendor patches or private miniaudio fields are required.

Project-authored code is dedicated to the public domain under CC0-1.0.
Compiler and operating-system components retain their respective licenses.
