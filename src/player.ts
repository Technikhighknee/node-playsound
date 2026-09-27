import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioError } from './errors.js';
import { Session } from './session.js';
import { applicationName } from './identity.js';
import type { Engine, EngineEvent, EngineFactory } from './session.js';

export type PlaybackResult = 'ended' | 'stopped';
export type PlaybackState = 'pending' | 'playing' | 'paused' | 'stopping' | 'ended' | 'stopped' | 'failed';
export type AudioFile = string | URL;

export interface PlayOptions {
  /** Linear gain from 0 (silent) to 1 (original level). Default: 1. */
  volume?: number;
  /** Aborting stops playback; it resolves finished with 'stopped'. */
  signal?: AbortSignal;
}
export interface SoundOptions { volume?: number }
export interface PlayerOptions {
  /** Application label in supported system audio controls. Defaults to the entry-point filename. */
  applicationName?: string;
  /** Maximum pending, playing, and paused plays, from 1 to 256. Default: 64. */
  maxConcurrent?: number;
}
export interface PlaybackTiming {
  /** Absolute seconds handed from the PCM stream to the mixer, not speaker time. */
  readonly position: number;
  /** Decoder-reported seconds, or null when unavailable. */
  readonly duration: number | null;
}
export interface Playback extends AsyncDisposable {
  /** Rejects with AudioError on failure. Always observe this promise. */
  readonly finished: Promise<PlaybackResult>;
  readonly state: PlaybackState;
  /** Changes only this playback. Valid assignments after completion are harmless. */
  volume: number;
  /** Idempotent. Resolves after playback resources are released. */
  stop(): Promise<PlaybackResult>;
  /** Request an absolute position in seconds. Failures reject finished. */
  seek(seconds: number): void;
  /** Idempotent request. State changes after acknowledgment; failures reject finished. */
  pause(): void;
  /** Resume without rewinding. Harmless unless pause was requested. */
  resume(): void;
  /** On-demand native snapshot. Overlapping calls share it; null after settlement. */
  getTiming(): Promise<PlaybackTiming | null>;
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
  #seek: (seconds: number) => void;
  #pause: (paused: boolean) => void;
  #timing: () => Promise<PlaybackTiming | null>;
  constructor(volume: number, stop: () => void, change: (volume: number) => void, seek: (seconds: number) => void, pause: (paused: boolean) => void, timing: () => Promise<PlaybackTiming | null>) {
    this.#volume = volume;
    this.#stop = stop;
    this.#change = change;
    this.#seek = seek;
    this.#pause = pause;
    this.#timing = timing;
    this.finished = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  get state(): PlaybackState { return this.#state; }
  get volume(): number { return this.#volume; }
  set volume(value: number) { this.#volume = gain(value); this.#change(value); }
  stop(): Promise<PlaybackResult> { this.#stop(); return this.finished; }
  seek(seconds: number): void {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
      throw new RangeError('Seek position must be a finite, nonnegative number of seconds.');
    this.#seek(seconds);
  }
  pause(): void { this.#pause(true); }
  resume(): void { this.#pause(false); }
  getTiming(): Promise<PlaybackTiming | null> { return this.#timing(); }
  paused(value: boolean): void { if (this.#state === 'playing' || this.#state === 'paused') this.#state = value ? 'paused' : 'playing'; }
  async [Symbol.asyncDispose](): Promise<void> { await this.stop(); }
  starting(paused: boolean): void { if (this.#state === 'pending') this.#state = paused ? 'paused' : 'playing'; }
  stopping(): void { this.#state = 'stopping'; }
  settle(result: PlaybackResult | AudioError): void {
    this.#stop = () => {};
    this.#change = () => {};
    this.#seek = () => {};
    this.#pause = () => {};
    this.#timing = () => Promise.resolve(null);
    if (result instanceof AudioError) { this.#state = 'failed'; this.#reject(result); }
    else { this.#state = result; this.#resolve(result); }
  }
}

interface Entry {
  id: number;
  path: string;
  handle: Handle;
  sent: boolean;
  seekTarget: number | undefined;
  seeking: number | undefined;
  desiredPaused: boolean;
  initialPaused: boolean;
  token: number;
  pauseRequest: { token: number; paused: boolean } | undefined;
  pauseTimer: NodeJS.Timeout | undefined;
  query: { promise: Promise<PlaybackTiming | null>; resolve: (value: PlaybackTiming | null) => void;
    reject: (error: AudioError) => void; token: number | undefined; timer: NodeJS.Timeout } | undefined;
  timer: NodeJS.Timeout | undefined;
  removeAbort: (() => void) | undefined;
}

/** Internal ownership boundary; tests inject an engine, not public API options. */
export class Controller {
  #limit: number;
  #factory: EngineFactory;
  #applicationName: string;
  #engine: Engine | undefined;
  #retiring = new Set<Promise<void>>();
  #entries = new Map<number, Entry>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #idle: NodeJS.Timeout | undefined;

  constructor(options: PlayerOptions = {}, factory?: EngineFactory) {
    object(options, 'Player options');
    const name = applicationName(options.applicationName);
    this.#applicationName = name;
    const limit = options.maxConcurrent === undefined ? 64 : options.maxConcurrent;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new RangeError('maxConcurrent must be an integer between 1 and 256.');
    this.#limit = limit;
    this.#factory = factory ?? ((event, failed, name) => new Session(event, failed, undefined, name));
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
    }, seconds => {
      if (this.#closed || !this.#entries.has(id) || handle.state === 'stopping') return;
      entry.seekTarget = seconds;
      this.#seek(entry);
    }, paused => {
      if (this.#closed || !this.#entries.has(id) || handle.state === 'stopping') return;
      entry.desiredPaused = paused;
      this.#pause(entry);
    }, () => this.#timing(entry));
    const entry: Entry = {
      id, path, handle, sent: false, seekTarget: undefined, seeking: undefined,
      desiredPaused: false, initialPaused: false, token: 0, pauseRequest: undefined,
      pauseTimer: undefined, query: undefined, timer: undefined, removeAbort: undefined,
    };
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
        const engine = this.#factory(event => { if (this.#engine === engine) this.#event(event); }, error => {
          if (this.#engine !== engine) return;
          this.#engine = undefined;
          this.#retire(engine);
          for (const current of [...this.#entries.values()]) this.#settle(current, error);
        }, this.#applicationName);
        this.#engine = engine;
      }
      entry.sent = true;
      entry.initialPaused = entry.desiredPaused;
      this.#engine.play(entry.id, entry.path, entry.handle.volume, entry.initialPaused);
    } catch (cause) {
      this.#settle(entry, cause instanceof AudioError ? cause : new AudioError('ENGINE_ERROR', 'Could not initialize the audio engine.', { cause }));
    }
  }

  #event(event: EngineEvent): void {
    const entry = this.#entries.get(event.id);
    if (!entry) return;
    if (event.type === 'started') {
      if (entry.handle.state !== 'pending' && entry.handle.state !== 'stopping') return;
      if (entry.handle.state !== 'stopping') { clearTimeout(entry.timer); entry.timer = undefined; }
      entry.handle.starting(entry.initialPaused);
      this.#pause(entry);
      this.#seek(entry);
      this.#query(entry);
    } else if (event.type === 'seeked') {
      if (entry.seeking !== event.token || !this.#active(entry)) return;
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.seeking = undefined;
      this.#seek(entry);
      this.#query(entry);
    } else if (event.type === 'paused') {
      if (!this.#active(entry) || entry.pauseRequest?.token !== event.token) return;
      if (entry.pauseRequest.paused !== event.paused) {
        this.#engine?.fail(new AudioError('ENGINE_ERROR', 'The audio engine acknowledged an incorrect pause state.'));
        return;
      }
      clearTimeout(entry.pauseTimer);
      entry.pauseTimer = undefined;
      entry.pauseRequest = undefined;
      entry.handle.paused(event.paused);
      this.#pause(entry);
      this.#query(entry);
    } else if (event.type === 'timing') {
      if (!this.#active(entry) || entry.query?.token !== event.token) return;
      clearTimeout(entry.query.timer);
      const query = entry.query;
      entry.query = undefined;
      query.resolve(Object.freeze({ position: event.position, duration: event.duration }));
    } else this.#settle(entry, event.type === 'done' ? event.reason : event.error);
  }

  #seek(entry: Entry): void {
    if (!this.#active(entry) || entry.seeking || entry.seekTarget === undefined) return;
    const seconds = entry.seekTarget;
    entry.seekTarget = undefined;
    const token = this.#token(entry);
    if (!token) return;
    entry.seeking = token;
    entry.timer = setTimeout(() => this.#timeout(entry, 'Audio seeking did not complete within 10 seconds.'), 10_000);
    this.#engine?.seek(entry.id, seconds, token);
  }

  #active(entry: Entry): boolean {
    return !this.#closed && this.#entries.has(entry.id) && (entry.handle.state === 'playing' || entry.handle.state === 'paused');
  }

  #token(entry: Entry): number {
    if (entry.token === Number.MAX_SAFE_INTEGER) {
      this.#engine?.fail(new AudioError('ENGINE_ERROR', 'Playback command token limit reached.'));
      return 0;
    }
    return ++entry.token;
  }

  #pause(entry: Entry): void {
    if (!this.#active(entry) || entry.pauseRequest || (entry.handle.state === 'paused') === entry.desiredPaused) return;
    const token = this.#token(entry);
    if (!token) return;
    entry.pauseRequest = { token, paused: entry.desiredPaused };
    entry.pauseTimer = setTimeout(() => this.#timeout(entry, 'Audio pause/resume did not complete within 10 seconds.'), 10_000);
    this.#engine?.pause(entry.id, token, entry.desiredPaused);
  }

  #timing(entry: Entry): Promise<PlaybackTiming | null> {
    if (this.#closed || !this.#entries.has(entry.id) || entry.handle.state === 'stopping') return Promise.resolve(null);
    if (!entry.query) {
      let resolve!: (value: PlaybackTiming | null) => void;
      let reject!: (error: AudioError) => void;
      const promise = new Promise<PlaybackTiming | null>((yes, no) => { resolve = yes; reject = no; });
      entry.query = { promise, resolve, reject, token: undefined,
        timer: setTimeout(() => this.#timeout(entry, 'Audio timing query did not complete within 10 seconds.'), 10_000) };
      this.#query(entry);
      return promise;
    }
    return entry.query.promise;
  }

  #query(entry: Entry): void {
    if (!this.#active(entry) || !entry.query || entry.query.token !== undefined || entry.seeking ||
      entry.seekTarget !== undefined || entry.pauseRequest || (entry.handle.state === 'paused') !== entry.desiredPaused) return;
    const token = this.#token(entry);
    if (!token) return;
    entry.query.token = token;
    this.#engine?.timing(entry.id, token);
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
    clearTimeout(entry.pauseTimer);
    if (entry.query) clearTimeout(entry.query.timer);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#timeout(entry, 'The audio engine did not stop playback within 2 seconds.'), 2000);
    this.#engine?.stop(entry.id);
  }

  #settle(entry: Entry, result: PlaybackResult | AudioError): void {
    if (!this.#entries.delete(entry.id)) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.pauseTimer);
    if (entry.query) {
      clearTimeout(entry.query.timer);
      if (result instanceof AudioError) entry.query.reject(result);
      else entry.query.resolve(null);
      entry.query = undefined;
    }
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
      clearTimeout(entry.pauseTimer);
      if (entry.query) clearTimeout(entry.query.timer);
      entry.removeAbort?.();
      entry.removeAbort = undefined;
      entry.handle.stopping();
    }
    return this.#closePromise;
  }
}
