import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioError } from './errors.js';
import { Session } from './session.js';
import type { Engine, EngineEvent, EngineFactory } from './session.js';

export type PlaybackResult = 'ended' | 'stopped';
export type PlaybackState = 'pending' | 'playing' | 'stopping' | 'ended' | 'stopped' | 'failed';
export type AudioFile = string | URL;

export interface PlayOptions {
  /** Linear gain from 0 (silent) to 1 (original level). Default: 1. */
  volume?: number;
  /** Aborting stops playback; it resolves finished with 'stopped'. */
  signal?: AbortSignal;
}
export interface SoundOptions { volume?: number }
export interface PlayerOptions {
  /** Maximum pending and active plays, from 1 to 256. Default: 64. */
  maxConcurrent?: number;
}
export interface Playback extends AsyncDisposable {
  /** Rejects with AudioError on failure. Always observe this promise. */
  readonly finished: Promise<PlaybackResult>;
  readonly state: PlaybackState;
  /** Changes only this playback. Valid assignments after completion are harmless. */
  volume: number;
  /** Idempotent. Resolves after playback resources are released. */
  stop(): Promise<PlaybackResult>;
}
export interface Sound {
  /** Each call creates an independent playback, including when calls overlap. */
  play(options?: PlayOptions): Playback;
}

function gain(value: number = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError('volume must be a finite number between 0 and 1.');
  return value;
}

function pathOf(file: AudioFile): string {
  const value = file instanceof URL ? fileURLToPath(file) : file;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw new TypeError('Audio file must be a nonempty local path or file: URL without NUL characters.');
  const path = resolve(value);
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length > 65536 || bytes.toString('utf8') !== path)
    throw new TypeError('Audio path must be valid Unicode and at most 65536 UTF-8 bytes.');
  return path;
}

function object(value: unknown, name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an options object.`);
}

class Handle implements Playback {
  readonly finished: Promise<PlaybackResult>;
  #resolve!: (result: PlaybackResult) => void;
  #reject!: (error: AudioError) => void;
  #state: PlaybackState = 'pending';
  #volume: number;
  #stop: () => void;
  #change: (volume: number) => void;
  constructor(volume: number, stop: () => void, change: (volume: number) => void) {
    this.#volume = volume;
    this.#stop = stop;
    this.#change = change;
    this.finished = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  get state(): PlaybackState { return this.#state; }
  get volume(): number { return this.#volume; }
  set volume(value: number) { this.#volume = gain(value); this.#change(value); }
  stop(): Promise<PlaybackResult> { this.#stop(); return this.finished; }
  async [Symbol.asyncDispose](): Promise<void> { await this.stop(); }
  starting(): void { if (this.#state === 'pending') this.#state = 'playing'; }
  stopping(): void { this.#state = 'stopping'; }
  settle(result: PlaybackResult | AudioError): void {
    this.#stop = () => {};
    this.#change = () => {};
    if (result instanceof AudioError) { this.#state = 'failed'; this.#reject(result); }
    else { this.#state = result; this.#resolve(result); }
  }
}

interface Entry {
  id: number;
  path: string;
  handle: Handle;
  sent: boolean;
  timer: NodeJS.Timeout | undefined;
  removeAbort: (() => void) | undefined;
}

/** Internal ownership boundary; tests inject an engine, not public API options. */
export class Controller {
  #limit: number;
  #factory: EngineFactory;
  #engine: Engine | undefined;
  #retiring = new Set<Promise<void>>();
  #entries = new Map<number, Entry>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #idle: NodeJS.Timeout | undefined;

  constructor(options: PlayerOptions = {}, factory: EngineFactory = (event, failed) => new Session(event, failed)) {
    object(options, 'Player options');
    const limit = options.maxConcurrent === undefined ? 64 : options.maxConcurrent;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new RangeError('maxConcurrent must be an integer between 1 and 256.');
    this.#limit = limit;
    this.#factory = factory;
  }

  sound(file: AudioFile, options: SoundOptions = {}): Sound {
    object(options, 'Sound options');
    const path = pathOf(file);
    const volume = gain(options.volume);
    return Object.freeze({ play: (options: PlayOptions = {}) => {
      object(options, 'Play options');
      return this.play(path, { ...options, volume: options.volume === undefined ? volume : options.volume });
    } });
  }

  play(file: AudioFile, options: PlayOptions = {}): Playback {
    const path = pathOf(file);
    object(options, 'Play options');
    const volume = gain(options.volume);
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const id = this.#nextId;
    this.#nextId = id === 0xffff_ffff ? 1 : id + 1;
    // IDs are only reused after four billion calls; still avoid active collisions.
    while (this.#entries.has(this.#nextId)) this.#nextId = this.#nextId === 0xffff_ffff ? 1 : this.#nextId + 1;
    const handle = new Handle(volume, () => this.#stop(entry), value => {
      if (entry.sent && this.#entries.has(id)) this.#engine?.volume(id, value);
    });
    const entry: Entry = { id, path, handle, sent: false, timer: undefined, removeAbort: undefined };
    if (this.#closed) { handle.settle(new AudioError('PLAYER_CLOSED', 'This player is closed. Create a new Player to play audio.')); return handle; }
    if (signal?.aborted) { handle.settle('stopped'); return handle; }
    if (this.#entries.size >= this.#limit) {
      handle.settle(new AudioError('PLAYBACK_LIMIT', `Playback limit (${this.#limit}) reached. Wait for a sound to finish or stop one first.`));
      return handle;
    }
    clearTimeout(this.#idle);
    this.#entries.set(id, entry);
    if (signal) {
      const abort = () => this.#stop(entry);
      signal.addEventListener('abort', abort, { once: true });
      entry.removeAbort = () => signal.removeEventListener('abort', abort);
    }
    entry.timer = setTimeout(() => this.#timeout(entry, 'Audio playback did not start within 10 seconds.'), 10_000);
    // Immediate stop/abort/close should not even enqueue a filesystem request.
    queueMicrotask(() => {
      if (!this.#closed && this.#entries.has(id)) void this.#start(entry);
    });
    return handle;
  }

  async #start(entry: Entry): Promise<void> {
    try {
      const info = await stat(entry.path);
      if (this.#closed || !this.#entries.has(entry.id)) return;
      if (!info.isFile()) throw new AudioError('FILE_ERROR', 'Audio source must be a regular file.');
    } catch (cause) {
      if (this.#closed) return;
      this.#settle(entry, cause instanceof AudioError ? cause : new AudioError('FILE_ERROR', 'Could not open the audio file.', { cause }));
      return;
    }
    try {
      if (!this.#engine) {
        const engine = this.#factory(event => this.#event(event), error => {
          if (this.#engine !== engine) return;
          this.#engine = undefined;
          this.#retire(engine);
          for (const current of [...this.#entries.values()]) this.#settle(current, error);
        });
        this.#engine = engine;
      }
      entry.sent = true;
      this.#engine.play(entry.id, entry.path, entry.handle.volume);
    } catch (cause) {
      this.#settle(entry, cause instanceof AudioError ? cause : new AudioError('ENGINE_ERROR', 'Could not initialize the audio engine.', { cause }));
    }
  }

  #event(event: EngineEvent): void {
    const entry = this.#entries.get(event.id);
    if (!entry) return;
    if (event.type === 'started') {
      if (entry.handle.state !== 'stopping') { clearTimeout(entry.timer); entry.timer = undefined; }
      entry.handle.starting();
    } else this.#settle(entry, event.type === 'done' ? event.reason : event.error);
  }

  #timeout(entry: Entry, message: string): void {
    if (!this.#entries.has(entry.id)) return;
    const error = new AudioError('TIMEOUT', message);
    if (entry.sent && this.#engine) this.#engine.fail(error);
    else this.#settle(entry, error);
  }

  #stop(entry: Entry): void {
    if (!this.#entries.has(entry.id) || entry.handle.state === 'stopping') return;
    if (!entry.sent) { this.#settle(entry, 'stopped'); return; }
    entry.handle.stopping();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#timeout(entry, 'The audio engine did not stop playback within 2 seconds.'), 2000);
    this.#engine?.stop(entry.id);
  }

  #settle(entry: Entry, result: PlaybackResult | AudioError): void {
    if (!this.#entries.delete(entry.id)) return;
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    entry.removeAbort = undefined;
    entry.handle.settle(result instanceof AudioError
      ? new AudioError(result.code, `${result.message} File: ${JSON.stringify(entry.path)}`, { cause: result }) : result);
    if (this.#entries.size === 0 && !this.#closed) {
      this.#idle = setTimeout(() => {
        if (this.#engine) { const engine = this.#engine; this.#engine = undefined; this.#retire(engine); }
      }, 250);
    }
  }

  #retire(engine: Engine): Promise<void> {
    const closing = engine.close();
    this.#retiring.add(closing);
    void closing.then(() => this.#retiring.delete(closing));
    return closing;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    clearTimeout(this.#idle);
    if (this.#engine) {
      const engine = this.#engine;
      this.#engine = undefined;
      this.#retire(engine);
    }
    // Settle after the engine exits, so close()/finished mean resources are gone.
    this.#closePromise = Promise.all([...this.#retiring]).then(() => {
      for (const entry of [...this.#entries.values()]) this.#settle(entry, 'stopped');
    });
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.removeAbort?.();
      entry.removeAbort = undefined;
      entry.handle.stopping();
    }
    return this.#closePromise;
  }
}
