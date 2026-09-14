import { Controller } from './player.js';
import type { AudioFile, Playback, PlayOptions, PlayerOptions, Sound, SoundOptions } from './player.js';

export { AudioError } from './errors.js';
export type { AudioErrorCode } from './errors.js';
export type { AudioFile, Playback, PlaybackResult, PlaybackState, PlayOptions, PlayerOptions, Sound, SoundOptions } from './player.js';

/** An independent playback group with deterministic shutdown. Construct lazily. */
export class Player implements AsyncDisposable {
  #controller: Controller;
  constructor(options: PlayerOptions = {}) { this.#controller = new Controller(options); }
  play(file: AudioFile, options?: PlayOptions): Playback { return this.#controller.play(file, options); }
  sound(file: AudioFile, options?: SoundOptions): Sound { return this.#controller.sound(file, options); }
  /** Stops all owned playback, releases the audio engine, and permanently closes this player. */
  close(): Promise<void> { return this.#controller.close(); }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}

// Importing the package opens no files, devices, processes, or timers.
let shared: Player | undefined;
/** Play a local file. Observe playback.finished for completion and errors. */
export function play(file: AudioFile, options?: PlayOptions): Playback {
  return (shared ??= new Player()).play(file, options);
}
/** Capture an absolute path and defaults for repeated, independent playback. */
export function sound(file: AudioFile, options?: SoundOptions): Sound {
  return (shared ??= new Player()).sound(file, options);
}
