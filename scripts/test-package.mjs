import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPackage } from './check-package.mjs';

// --local checks installation on this host before CI assembles the other builds.
// It never changes or bypasses the release prepack/prepublish checks.
const local = process.argv.includes('--local');
checkPackage(local ? [`${process.platform}-${process.arch}`] : undefined);
const temporary = mkdtempSync(join(tmpdir(), 'playsound-package-'));
const npm = process.env.npm_execpath;
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
if (!npm) throw new Error('Run through npm: npm run test:package [-- --local]');
try {
  const packed = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], process.cwd()))[0];
  const names = packed.files.map(file => file.path);
  const allowed = /^(?:package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|dist\/[a-z]+\.(?:js|d\.ts)|bin\/(?:win32|darwin|linux)-(?:x64|arm64)\/(?:playsound(?:\.exe)?|manifest\.json))$/;
  for (const name of names) if (!allowed.test(name)) throw new Error(`Unexpected package file: ${name}`);
  if (!names.includes('dist/index.d.ts') || !names.includes('LICENSE')) throw new Error('Missing public package files.');
  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/node-playsound/package.json'), 'utf8'));
  if (installed.dependencies || readdirSync(join(consumer, 'node_modules')).filter(name => !name.startsWith('.')).length !== 1)
    throw new Error('Installation pulled runtime dependencies.');
  const source = `import { play, sound, Player, AudioError } from 'node-playsound';
import assert from 'node:assert/strict';
const cancelled = AbortSignal.abort();
assert.equal(await play('unused.wav', { signal: cancelled }).finished, 'stopped');
assert.equal(await sound('unused.wav').play({ signal: cancelled }).finished, 'stopped');
const player = new Player({ maxConcurrent: 2 });
await player.close();
await assert.rejects(player.play('unused.wav').finished, error => error instanceof AudioError && error.code === 'PLAYER_CLOSED');
console.log('Installed ESM package works without runtime dependencies.');
`;
  writeFileSync(join(consumer, 'consumer.mjs'), source);
  console.log(run(process.execPath, ['consumer.mjs'], consumer).trim());
  writeFileSync(join(consumer, 'consumer.mts'), `import { play, sound, Player, AudioError, type Playback, type PlaybackResult } from 'node-playsound';
const playback: Playback = play(new URL('file:///tone.wav'), { volume: 0.5, signal: AbortSignal.abort() });
const result: Promise<PlaybackResult> = playback.finished;
playback.volume = 0.2;
void playback.stop();
void result;
void sound('tone.wav').play();
void new Player()[Symbol.asyncDispose]();
void new AudioError('DEVICE_ERROR', 'No device');
// @ts-expect-error gain is a number
play('tone.wav', { volume: 'loud' });
// @ts-expect-error state is read-only
playback.state = 'ended';
// @ts-expect-error no implementation-specific options
new Player({ executable: 'ffplay' });
`);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,ESNext.Disposable', '--typeRoots', resolve('node_modules/@types'), join(consumer, 'consumer.mts')], consumer);
  console.log(`Installed TypeScript API verified; ${names.length} files, ${packed.size} compressed bytes.`);
} finally {
  // This directory was created by mkdtemp for this run, outside the repository.
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('playsound-package-'))
    throw new Error('Refusing to clean an unexpected temporary directory.');
  rmSync(temporary, { recursive: true, force: true });
}
