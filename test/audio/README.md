These 0.2-second, 440 Hz synthetic tones are project-authored CC0 test data.
Generated with FFmpeg 8.1.1 (development only; FFmpeg is not shipped or used
by the library):

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.2 -map_metadata -1 -c:a libmp3lame -b:a 64k tone.mp3
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.2 -map_metadata -1 -c:a flac tone.flac
```

WAV fixtures are generated directly by `test/fixtures.mjs`.
