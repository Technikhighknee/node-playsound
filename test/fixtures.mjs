import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function wav(seconds = 0.1) {
  const rate = 48000;
  const frames = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  // Low-level sine, not silence: the native render tests can measure gain.
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1000), 44 + i * 2);
  return buffer;
}

export async function fixture(t, seconds = 0.1) {
  const directory = await mkdtemp(join(tmpdir(), 'playsound-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "space ' & 音 🎵.wav");
  await writeFile(path, wav(seconds));
  return { directory, path };
}
