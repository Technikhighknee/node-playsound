import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import { Session, executable, exitMessage } from '../dist/session.js';
import { Controller } from '../dist/player.js';
import { fixture } from './fixtures.mjs';

function session(t, mode) {
  const events = [];
  let fail;
  const failed = new Promise(resolve => { fail = resolve; });
  const engine = new Session(event => events.push(event), fail, [process.execPath, resolve('test/engine-fixture.mjs'), mode]);
  t.after(() => engine.close());
  return { engine, events, failed };
}

test('native illegal-instruction crashes explain CPU compatibility', () => {
  for (const code of [0xc000001d, -1073741795]) {
    assert.match(exitMessage(code, null), /illegal CPU instruction \(0xC000001D\)/);
    assert.match(exitMessage(code, null), /CPU features unavailable/);
  }
  assert.match(exitMessage(null, 'SIGILL'), /illegal CPU instruction \(SIGILL\)/);
  assert.equal(exitMessage(17, null), 'Audio engine exited unexpectedly (17).');
  assert.equal(exitMessage(null, 'SIGTERM'), 'Audio engine exited unexpectedly (SIGTERM).');
});

test('transport accepts split and batched protocol messages', { timeout: 5000 }, async t => {
  const { engine, events } = session(t, 'normal');
  engine.play(1, 'a\n" & 音.wav', 0.5);
  while (events.length < 2) await turn();
  assert.deepEqual(events, [{ type: 'started', id: 1 }, { type: 'done', id: 1, reason: 'ended' }]);
  const closing = engine.close();
  assert.equal(engine.close(), closing);
  await closing;
});

for (const mode of ['exit', 'crash', 'oversize', 'garbage', 'duplicate', 'device', 'decoder-timeout']) {
  test(`transport contains ${mode} failures`, { timeout: 5000 }, async t => {
    const { engine, failed } = session(t, mode);
    engine.play(1, 'ignored', 1);
    const error = await failed;
    assert.equal(error.code, mode === 'device' ? 'DEVICE_ERROR' : mode === 'decoder-timeout' ? 'TIMEOUT' : 'ENGINE_ERROR');
    await engine.close();
  });
}

test('spawn failure is reported and close completes', { timeout: 5000 }, async t => {
  let fail;
  const failed = new Promise(resolve => { fail = resolve; });
  const engine = new Session(() => {}, fail, [resolve('.tmp/no-such-executable')]);
  t.after(() => engine.close());
  assert.equal((await failed).code, 'ENGINE_ERROR');
  await engine.close();
});

test('unresponsive startup is bounded', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, failed } = session(t, 'hang');
  t.mock.timers.tick(10000);
  assert.equal((await failed).code, 'TIMEOUT');
  await engine.close();
});

test('stop cancels buffered playback without waiting for engine readiness', { timeout: 5000 }, async t => {
  const { engine, events } = session(t, 'hang');
  engine.play(1, 'unused', 1, true);
  engine.pause(1, 1, false);
  engine.timing(1, 2);
  engine.volume(1, 0.2);
  engine.stop(1);
  assert.deepEqual(events, [{ type: 'done', id: 1, reason: 'stopped' }]);
  await engine.close();
});

test('platform selection rejects unsupported architectures explicitly', () => {
  assert.throws(() => executable('freebsd', 'x64'), { code: 'UNSUPPORTED_PLATFORM' });
  assert.match(executable('darwin', 'arm64'), /darwin-arm64/);
});

test('stop removes an unwritten seek after play was written under real pipe backpressure', { timeout: 5000 }, async t => {
  const { engine, events } = session(t, 'backpressure');
  const { directory } = await fixture(t);
  const gate = join(directory, 'resume');
  engine.play(1, gate, 1);
  while (!events.some(e => e.type === 'started' && e.id === 1)) await turn();
  // The child has paused reads until we create the gate. Fill the OS pipe
  // too: a single large write can complete synchronously on Linux.
  for (let id = 2; id <= 33; id++) engine.play(id, 'x'.repeat(65536), 1);
  engine.seek(1, 80, 1);
  engine.pause(1, 2, true);
  engine.timing(1, 3);
  engine.volume(1, 0.5);
  engine.seek(2, 10, 1);
  engine.stop(1);
  await writeFile(gate, 'resume');
  while (!events.some(e => e.type === 'done' && e.id === 1)) await turn();
  assert.ok(!events.some(e => ['seeked', 'paused', 'timing'].includes(e.type) && e.id === 1), 'stopped voice must not execute its queued seek');
  assert.ok(events.some(e => e.type === 'seeked' && e.id === 2), 'peer seek must survive');
  engine.stop(2);
  while (!events.some(e => e.type === 'done' && e.id === 2)) await turn();
});

test('TypeScript lifecycle integrates with native engine through actual pipes', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 0.2);
  const player = new Controller({}, (event, failed) => new Session(event, failed,
    [resolve(`.tmp/playsound-test${process.platform === 'win32' ? '.exe' : ''}`), '--null', '--parent', String(process.pid)]));
  t.after(() => player.close());
  const a = player.play(path); const b = player.play(path);
  assert.deepEqual(await Promise.all([a.finished, b.finished]), ['ended', 'ended']);
  const c = player.play(path);
  while (c.state === 'pending') await turn();
  assert.equal(await c.stop(), 'stopped');
  await player.close();
});

test('seeking through actual pipes preserves peers, cancellation, and completion', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 3);
  const player = new Controller({}, (event, failed) => new Session(event, failed,
    [resolve(`.tmp/playsound-test${process.platform === 'win32' ? '.exe' : ''}`), '--null', '--parent', String(process.pid)]));
  t.after(() => player.close());
  const a = player.play(path); const b = player.play(path);
  a.seek(1.25);
  while (a.state === 'pending' || b.state === 'pending') await turn();
  for (let i = 0; i < 10000; i++) a.seek(i % 2);
  a.seek(Number.MAX_VALUE);
  assert.equal(await a.finished, 'ended');
  assert.equal(b.state, 'playing');
  assert.equal(await b.stop(), 'stopped');
  a.seek(0);
  const abort = new AbortController();
  const c = player.play(path, { signal: abort.signal });
  while (c.state === 'pending') await turn();
  c.seek(2);
  abort.abort();
  assert.equal(await c.finished, 'stopped');
  const d = player.play(path);
  while (d.state === 'pending') await turn();
  d.seek(1);
  await player.close();
  assert.equal(await d.finished, 'stopped');
});

for (const response of ['PAUSED 1 1 2', 'PAUSED 1 1 1 extra', 'PAUSED 1 0 1', 'TIMING 1 1 -1 2',
  'TIMING 1 1 NaN -', 'TIMING 1 1 1 Infinity', 'TIMING 1 1 1e309 2', 'TIMING 1 9007199254740992 0 1',
  'TIMING 1 1 0', 'TIMING 4294967296 1 0 1', 'SEEKED 1', 'SEEKED 1 0']) {
  test(`transport rejects malformed timing/control response: ${response}`, { timeout: 5000 }, async t => {
    const { engine, failed } = session(t, `response:${response}`);
    engine.play(1, 'unused', 1);
    assert.equal((await failed).code, 'ENGINE_ERROR');
  });
}

test('pause, seek, timing and peer playback integrate through native pipes', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 3);
  const player = new Controller({}, (event, failed) => new Session(event, failed,
    [resolve(`.tmp/playsound-test${process.platform === 'win32' ? '.exe' : ''}`), '--null', '--parent', String(process.pid)]));
  t.after(() => player.close());
  const a = player.play(path); a.pause();
  const b = player.play(path);
  assert.deepEqual(await a.getTiming(), { position: 0, duration: 3 });
  assert.equal(a.state, 'paused');
  a.seek(1.25);
  assert.deepEqual(await a.getTiming(), { position: 1.25, duration: 3 });
  assert.equal(a.state, 'paused');
  const before = await b.getTiming();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await a.getTiming()).position, 1.25);
  assert.ok((await b.getTiming()).position > before.position);
  a.resume();
  await a.getTiming();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok((await a.getTiming()).position > 1.25);
  a.pause(); a.seek(0.25);
  assert.equal((await a.getTiming()).position, 0.25);
  a.volume = 0.2;
  assert.equal(await a.stop(), 'stopped');
  assert.equal(await a.getTiming(), null);
  b.pause(); await b.getTiming();
  await player.close();
  assert.equal(await b.finished, 'stopped');
});
