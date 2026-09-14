import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { Session, executable } from '../dist/session.js';
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

test('transport accepts split and batched protocol messages', { timeout: 5000 }, async t => {
  const { engine, events } = session(t, 'normal');
  engine.play(1, 'a\n" & 音.wav', 0.5);
  while (events.length < 2) await turn();
  assert.deepEqual(events, [{ type: 'started', id: 1 }, { type: 'done', id: 1, reason: 'ended' }]);
  const closing = engine.close();
  assert.equal(engine.close(), closing);
  await closing;
});

for (const mode of ['exit', 'crash', 'oversize', 'garbage', 'duplicate', 'device']) {
  test(`transport contains ${mode} failures`, { timeout: 5000 }, async t => {
    const { engine, failed } = session(t, mode);
    engine.play(1, 'ignored', 1);
    const error = await failed;
    assert.equal(error.code, mode === 'device' ? 'DEVICE_ERROR' : 'ENGINE_ERROR');
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
  engine.play(1, 'unused', 1);
  engine.volume(1, 0.2);
  engine.stop(1);
  assert.deepEqual(events, [{ type: 'done', id: 1, reason: 'stopped' }]);
  await engine.close();
});

test('platform selection rejects unsupported architectures explicitly', () => {
  assert.throws(() => executable('freebsd', 'x64'), { code: 'UNSUPPORTED_PLATFORM' });
  assert.match(executable('darwin', 'arm64'), /darwin-arm64/);
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
