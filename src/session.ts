import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AudioError } from './errors.js';

export type EngineEvent =
  | { type: 'started'; id: number }
  | { type: 'seeked'; id: number }
  | { type: 'done'; id: number; reason: 'ended' | 'stopped' }
  | { type: 'error'; id: number; error: AudioError };

export interface Engine {
  play(id: number, path: string, volume: number): void;
  stop(id: number): void;
  volume(id: number, volume: number): void;
  seek(id: number, seconds: number): void;
  close(): Promise<void>;
  fail(error: AudioError): void;
}

export type EngineFactory = (
  event: (event: EngineEvent) => void,
  failed: (error: AudioError) => void,
) => Engine;

const supported = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);

export function executable(platform = process.platform, arch = process.arch): string {
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) {
    throw new AudioError('UNSUPPORTED_PLATFORM', `Audio playback is not available for ${target}. Supported: ${[...supported].join(', ')}.`);
  }
  return fileURLToPath(new URL(`../bin/${target}/playsound${platform === 'win32' ? '.exe' : ''}`, import.meta.url));
}

/** Internal transport. The injectable command is used only by process-level tests. */
export class Session implements Engine {
  #child: ChildProcessWithoutNullStreams;
  #ready = false;
  #closing = false;
  #failed = false;
  #exited = false;
  #buffer = '';
  #stderr = '';
  #blocked = false;
  #queue = new Map<string, string>();
  #bytes = 0;
  #startup: NodeJS.Timeout;
  #killTimer: NodeJS.Timeout | undefined;
  #closed: Promise<void>;
  #event: (event: EngineEvent) => void;
  #failure: (error: AudioError) => void;

  constructor(event: (event: EngineEvent) => void, failed: (error: AudioError) => void,
    command: readonly [string, ...string[]] = [executable(), '--parent', String(process.pid)]) {
    this.#event = event;
    this.#failure = failed;
    this.#child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#closed = new Promise(resolve => {
      this.#child.once('close', (code, signal) => {
        this.#exited = true;
        clearTimeout(this.#startup);
        clearTimeout(this.#killTimer);
        if (!this.#closing) this.fail(new AudioError('ENGINE_ERROR', `Audio engine exited unexpectedly (${signal ?? code}).${this.#stderr ? ` ${this.#stderr}` : ''}`));
        resolve();
      });
    });
    this.#child.once('error', cause => this.fail(new AudioError('ENGINE_ERROR', 'Could not start the bundled audio engine. Reinstall the package and check executable permissions.', { cause })));
    this.#child.stdin.on('error', cause => {
      if (!this.#closing) this.fail(new AudioError('ENGINE_ERROR', 'The audio engine command channel failed.', { cause }));
    });
    this.#child.stdout.on('error', cause => this.fail(new AudioError('ENGINE_ERROR', 'The audio engine response channel failed.', { cause })));
    this.#child.stderr.on('error', () => {});
    this.#child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-2048);
    });
    this.#child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.#read(chunk));
    this.#child.stdin.on('drain', () => { this.#blocked = false; this.#flush(); });
    this.#startup = setTimeout(() => this.fail(new AudioError('TIMEOUT', 'The audio engine did not start within 10 seconds. Check the system audio device.')), 10_000);
  }

  play(id: number, path: string, volume: number): void {
    this.#send(`P${id}`, `P ${id} ${volume} ${Buffer.from(path).toString('hex')}\n`);
  }
  stop(id: number): void {
    const queuedPlay = this.#queue.has(`P${id}`);
    // Cancel commands we still own, even when play has already entered the
    // pipe. Bytes accepted by stdin.write() cannot be recalled or reordered.
    for (const key of [`P${id}`, `V${id}`, `Q${id}`]) {
      this.#bytes -= this.#queue.get(key)?.length ?? 0;
      this.#queue.delete(key);
    }
    if (queuedPlay) {
      this.#event({ type: 'done', id, reason: 'stopped' });
    } else this.#send(`S${id}`, `S ${id}\n`);
  }
  volume(id: number, volume: number): void { this.#send(`V${id}`, `V ${id} ${volume}\n`); }
  seek(id: number, seconds: number): void { this.#send(`Q${id}`, `Q ${id} ${seconds}\n`); }

  #send(key: string, command: string): void {
    if (this.#closing) return;
    this.#bytes += command.length - (this.#queue.get(key)?.length ?? 0);
    if (this.#bytes > 40 * 1024 * 1024) {
      this.fail(new AudioError('ENGINE_ERROR', 'The audio engine is not accepting commands.'));
      return;
    }
    this.#queue.set(key, command);
    this.#flush();
  }

  #flush(): void {
    if (!this.#ready || this.#blocked || this.#closing) return;
    for (const [key, command] of this.#queue) {
      this.#queue.delete(key);
      this.#bytes -= command.length;
      if (!this.#child.stdin.write(command)) { this.#blocked = true; break; }
    }
  }

  #read(chunk: string): void {
    if (this.#closing) return;
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 256 || !this.#line(line)) {
        this.fail(new AudioError('ENGINE_ERROR', 'The bundled audio engine returned an invalid response.'));
        return;
      }
      if (this.#closing) return;
    }
    if (this.#buffer.length > 256) this.fail(new AudioError('ENGINE_ERROR', 'The audio engine exceeded the response size limit.'));
  }

  #line(line: string): boolean {
    if (line === 'READY 2' && !this.#ready) {
      this.#ready = true;
      clearTimeout(this.#startup);
      this.#flush();
      return true;
    }
    if (/^FATAL DEVICE -?\d+$/.test(line)) {
      this.fail(new AudioError('DEVICE_ERROR', `Could not use the system audio output (${line.split(' ')[2]}). Check that an output device and audio session are available.`));
      return true;
    }
    if (line === 'FATAL TIMEOUT 0') {
      this.fail(new AudioError('TIMEOUT', 'The audio decoder did not finish an operation within 10 seconds.'));
      return true;
    }
    if (!this.#ready) return false;
    const match = /^(STARTED|SEEKED|DONE|ERROR) ([1-9]\d*)(?: (ended|stopped|FILE|DECODE|DEVICE|LIMIT)(?: (-?\d+))?)?$/.exec(line);
    if (!match) return false;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || id > 0xffff_ffff) return false;
    if (match[1] === 'STARTED' && !match[3]) this.#event({ type: 'started', id });
    else if (match[1] === 'SEEKED' && !match[3]) this.#event({ type: 'seeked', id });
    else if (match[1] === 'DONE' && (match[3] === 'ended' || match[3] === 'stopped') && !match[4])
      this.#event({ type: 'done', id, reason: match[3] });
    else if (match[1] === 'ERROR' && match[4] !== undefined) {
      const kind = match[3];
      const code = kind === 'DECODE' ? 'DECODE_ERROR' : kind === 'FILE' ? 'FILE_ERROR' : kind === 'DEVICE' ? 'DEVICE_ERROR' : kind === 'LIMIT' ? 'PLAYBACK_LIMIT' : undefined;
      if (!code) return false;
      this.#event({ type: 'error', id, error: new AudioError(code, `Audio playback failed: ${kind?.toLowerCase()} (${match[4]}).${kind === 'DECODE' ? ' The file may be damaged or unsupported; use WAV, MP3, or FLAC.' : ''}`) });
    } else return false;
    return true;
  }

  fail(error: AudioError): void {
    if (this.#failed || this.#closing) return;
    this.#failed = true;
    void this.close();
    this.#child.kill('SIGKILL');
    this.#failure(error);
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      clearTimeout(this.#startup);
      this.#queue.clear();
      this.#bytes = 0;
      if (!this.#exited) {
        this.#child.stdin.end('QUIT\n');
        this.#killTimer = setTimeout(() => this.#child.kill('SIGKILL'), 2000);
      }
    }
    return this.#closed;
  }
}
