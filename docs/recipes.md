# Recipes

[Quickstart](../README.md) · [API reference](api.md) · [Troubleshooting](troubleshooting.md)

Every example observes completion. Attach an error handler immediately if the
application continues doing other work before a sound finishes.

## Resolve files reliably

A relative string is resolved against `process.cwd()`. For an asset beside your
module, use a file URL so launching from another directory does not break it:

```ts
import { play } from 'node-playsound';

await play(new URL('./assets/notification.wav', import.meta.url)).finished;
```

For user-supplied paths, pass the string directly; do not add shell quotes or
escape spaces. The library does not use a shell. Keep the file available and
unchanged until playback ends. `sound()` captures its absolute path when you
create it, even if your application later changes its working directory.

## Play sequentially or concurrently

Await each completion to play a sequence. This does not promise gapless audio:

```ts
import { Player } from 'node-playsound';

const audio = new Player();
try {
  for (const file of ['./first.wav', './second.mp3']) {
    await audio.play(file).finished;
  }
} finally {
  await audio.close();
}
```

Call `play` more than once without awaiting between calls to overlap sounds:

```ts
import { Player } from 'node-playsound';

const audio = new Player();
try {
  const first = audio.play('./first.wav', { volume: 0.3 });
  const second = audio.play('./second.wav', { volume: 0.3 });
  await Promise.all([first.finished, second.finished]);
} finally {
  await audio.close();
}
```

`Promise.all` observes both promises. If either fails, `finally` closes this
player and stops the remaining sound. Use `Promise.allSettled` instead if you
want all sounds to run to their own completion and inspect each result.

## Send a background notification

For a notification that should not delay the rest of the application, handle
its failure at the point where you start it:

```ts
import { sound, AudioError } from 'node-playsound';

const notification = sound('./notification.wav', { volume: 0.3 });

function notify(): void {
  void notification.play().finished.catch((error: unknown) => {
    if (error instanceof AudioError) {
      console.error(`Notification audio failed: ${error.code}`, error.message);
    } else {
      console.error('Unexpected notification failure', error);
    }
  });
}

notify();
```

`void` alone does not handle a rejected promise; the `.catch` does. Each call
creates a new play, so bursts can overlap or hit the concurrency limit. If your
application should drop, queue, or replace notifications, make that policy in
the application rather than retrying `PLAYBACK_LIMIT` in a tight loop.

## Cancel a sound with an operation

```ts
import { play } from 'node-playsound';

const result = await play('./waiting.mp3', {
  signal: AbortSignal.timeout(5_000),
}).finished;

console.log(result); // 'ended' if it finishes, otherwise 'stopped' on abort.
```

Pass an existing operation's `AbortSignal` the same way. A pre-aborted signal
starts no audio. Abort, `stop()`, and natural completion can race; the first
completion result is final. Decoder/device errors still reject `finished`.

## Seek while playback is active

The method can be called as soon as you have a handle. This example requests
80 seconds during startup and then waits for the remainder of the track:

```ts
import { play } from 'node-playsound';

const playback = play('./track.mp3');
playback.seek(80);
await playback.finished;
```

From an application event handler, call `playback.seek(seconds)` again on the
same active handle. Positions are absolute seconds, not percentages or offsets
from the current position. Validate user input before calling: negative values,
`NaN`, and infinity throw synchronously. A startup seek can allow some initial
audio before taking effect; it is not a guaranteed silent start offset.

Do not await `seek()` expecting an acknowledgment: it returns `void`. Continue
observing `finished`. [The reference](api.md#seeking) defines coalescing,
beyond-end requests, completed handles, and failure behavior.

## Shut down an application or worker

Give the application an explicit `Player`, observe every playback, and await
`audio.close()` from its existing shutdown procedure. Do not call `process.exit()`
first. The library does not install signal handlers or make shutdown decisions
for your application.

Closing stops the player's pending and active plays and waits for the engine
to exit. It is safe to call more than once, but the player cannot be reused.
Create a new player for a later lifecycle. Other players are unaffected.

In a Node worker thread, run and await `close()` inside the worker before the
parent calls `worker.terminate()`. Forced termination can leave an exited child
process record on POSIX; cooperative cleanup avoids it. See [shutdown](api.md#shutdown).

## Run the repository examples

From a checkout with `dist` and the bundled native binaries built, these use
Node's package self-reference to exercise the public API:

```sh
node examples/basic.mjs ./sound.mp3
node examples/scoped.mjs ./notification.wav
node examples/seeking.mjs ./track.flac 80
```

- [basic.mjs](../examples/basic.mjs) plays one file and reports errors.
- [scoped.mjs](../examples/scoped.mjs) overlaps two plays, cancels one on a deadline,
  and closes the player in `finally`.
- [seeking.mjs](../examples/seeking.mjs) seeks to an absolute position and waits for completion.

For a source checkout, follow [development setup](development.md) first. To use
an installed package, copy an example into your own ESM project; no compiler is
needed on the consumer's machine.


## Pause and inspect a playback

Keep observing completion while awaiting a timing query: either can reject.
Pausing retains resources, so this example always closes its owner.

```ts
import { Player } from 'node-playsound';

const player = new Player();
try {
  const playback = player.play('./track.flac');
  playback.pause(); // Synchronous request before dispatch: start paused.
  const inspect = async () => {
    playback.seek(80);
    const timing = await playback.getTiming(); // Waits for the seek; stays paused.
    if (timing) {
      console.log(timing.position, timing.duration ?? 'unknown duration');
      playback.resume();
    }
  };
  await Promise.all([playback.finished, inspect()]);
} finally {
  await player.close();
}
```

For a progress display, query serially at the display's required rate rather than
starting overlapping intervals. The returned position reflects mixer consumption,
not speaker time. Stop refreshing when a query returns null. `finished` remains
the authority for completion and failure.
