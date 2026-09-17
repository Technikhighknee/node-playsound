import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { Controller } from '../dist/player.js';
import { AudioError, Player } from '../dist/index.js';
import { fixture } from './fixtures.mjs';

async function until(predicate) {
  for (let i = 0; i < 10000; i++) { if (predicate()) return; await turn(); }
  assert.fail('condition did not become true');
}

function setup(t, options) {
  const engines = [];
  const player = new Controller(options, (event, failed) => {
    const engine = {
      calls: [], closed: 0, tokens: new Map(), event(value) { event(value.type === 'seeked' && value.token === undefined ? { ...value, token: this.tokens.get(value.id) } : value); },
      play(...args) { this.calls.push(['play', ...args]); },
      stop(id) { this.calls.push(['stop', id]); },
      volume(...args) { this.calls.push(['volume', ...args]); },
      pause(...args) { this.calls.push(['pause', ...args]); },
      timing(...args) { this.calls.push(['timing', ...args]); },
      seek(id, seconds, token) { this.tokens.set(id, token); this.calls.push(['seek', id, seconds]); },
      close() { this.closed++; return Promise.resolve(); },
      fail(error) { failed(error); },
    };
    engines.push(engine);
    return engine;
  });
  t.after(() => player.close());
  return { player, engines, started: async count => {
    await until(() => engines[0]?.calls.filter(c => c[0] === 'play').length === count);
    return engines[0];
  } };
}

test('invalid arguments fail synchronously without creating an engine', t => {
  const { player, engines } = setup(t);
  for (const path of ['', null, 12, 'a\0b', '\ud800', new URL('https://example.com/a.mp3')])
    assert.throws(() => player.play(path), TypeError);
  for (const volume of [-1, 1.1, NaN, Infinity, '1', null])
    assert.throws(() => player.play('a', { volume }), RangeError);
  assert.throws(() => player.play('a', { signal: {} }), TypeError);
  assert.throws(() => player.play('a', null), TypeError);
  for (const maxConcurrent of [0, 257, 1.5, '2', null]) assert.throws(() => new Player({ maxConcurrent }), RangeError);
  assert.throws(() => player.sound('a').play({ volume: null }), RangeError);
  assert.equal(engines.length, 0);
});

test('missing files and directories produce useful operational errors', async t => {
  const { directory } = await fixture(t);
  const { player, engines } = setup(t);
  for (const path of [directory, join(directory, 'missing')]) {
    const p = player.play(path);
    await assert.rejects(p.finished, error => error instanceof AudioError && error.code === 'FILE_ERROR' && error.message.includes(directory.split('\\').join('\\\\')));
    assert.equal(p.state, 'failed');
  }
  assert.equal(engines.length, 0);
});

test('reusable sounds create independent overlapping handles and retain defaults', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const options = { volume: 0.3 };
  const sound = player.sound(pathToFileURL(path), options);
  options.volume = 0.8;
  const a = sound.play(); const b = sound.play({ volume: 0.6 });
  assert.notEqual(a, b);
  const engine = await started(2);
  const calls = engine.calls.filter(c => c[0] === 'play');
  assert.deepEqual(calls.map(c => c[3]).sort(), [0.3, 0.6]);
  engine.event({ type: 'started', id: 1 });
  assert.equal(a.state, 'playing');
  a.volume = 0.2;
  assert.deepEqual(engine.calls.at(-1), ['volume', 1, 0.2]);
  engine.event({ type: 'done', id: 1, reason: 'ended' });
  assert.equal(await a.finished, 'ended');
  assert.equal(b.state, 'pending');
  engine.event({ type: 'done', id: 2, reason: 'ended' });
  await b.finished;
  const c = sound.play();
  await started(3);
  engine.event({ type: 'done', id: 3, reason: 'ended' });
  await c.finished;
});

test('stop before file validation completes starts no resources', async t => {
  const { path } = await fixture(t);
  const { player, engines } = setup(t);
  const p = player.play(path);
  assert.equal(p.stop(), p.finished);
  assert.equal(await p.finished, 'stopped');
  await turn();
  assert.equal(engines.length, 0);
  assert.equal(await p.stop(), 'stopped');
});

test('many immediately cancelled calls do not accumulate engine work', async t => {
  const { player, engines } = setup(t);
  const completions = Array.from({ length: 1000 }, () => player.play('unused.wav').stop());
  assert.ok((await Promise.all(completions)).every(result => result === 'stopped'));
  assert.equal(engines.length, 0);
});

test('stop after dispatch waits for acknowledgment, remains idempotent across STARTED', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const engine = await started(1);
  p.stop(); p.stop();
  assert.equal(p.state, 'stopping');
  assert.equal(engine.calls.filter(c => c[0] === 'stop').length, 1);
  engine.event({ type: 'started', id: 1 });
  assert.equal(p.state, 'stopping');
  engine.event({ type: 'done', id: 1, reason: 'stopped' });
  assert.equal(await p.finished, 'stopped');
  engine.event({ type: 'done', id: 1, reason: 'ended' });
  assert.equal(p.state, 'stopped');
});

test('abort is a stop and listeners are removed after completion', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const abort = new AbortController();
  const p = player.play(path, { signal: abort.signal });
  const engine = await started(1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort();
  engine.event({ type: 'done', id: 1, reason: 'stopped' });
  assert.equal(await p.finished, 'stopped');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(await player.play(path, { signal: abort.signal }).finished, 'stopped');
});

test('pending plays count toward the limit and cancellation frees capacity', async t => {
  const { path } = await fixture(t);
  const { player } = setup(t, { maxConcurrent: 1 });
  const a = player.play(path);
  await assert.rejects(player.play(path).finished, { code: 'PLAYBACK_LIMIT' });
  await a.stop();
  const b = player.play(path);
  assert.equal(await b.stop(), 'stopped');
});

test('volume changed while pending is used for initial playback', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  p.volume = 0.4;
  const engine = await started(1);
  assert.equal(engine.calls[0][3], 0.4);
  engine.event({ type: 'done', id: 1, reason: 'ended' });
  await p.finished;
  p.volume = 0;
  assert.equal(engine.calls.length, 1);
  assert.throws(() => { p.volume = Infinity; }, RangeError);
});

test('seeks wait for startup, coalesce, and do not restart settled playback', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  for (const invalid of [-1, NaN, Infinity, -Infinity, null, '80', undefined])
    assert.throws(() => p.seek(invalid), RangeError);
  assert.equal(p.seek(20), undefined);
  p.seek(80.25);
  const engine = await started(1);
  assert.equal(engine.calls.length, 1);
  engine.event({ type: 'started', id: 1 });
  assert.deepEqual(engine.calls.at(-1), ['seek', 1, 80.25]);
  for (let i = 0; i < 10000; i++) p.seek(i);
  assert.equal(engine.calls.length, 2);
  engine.event({ type: 'seeked', id: 1 });
  assert.deepEqual(engine.calls.at(-1), ['seek', 1, 9999]);
  p.stop();
  const count = engine.calls.length;
  p.seek(0);
  engine.event({ type: 'seeked', id: 1 });
  assert.equal(engine.calls.length, count);
  engine.event({ type: 'done', id: 1, reason: 'stopped' });
  await p.finished;
  p.seek(0);
  assert.throws(() => p.seek(-1), RangeError);
  assert.equal(engine.calls.length, count);
});

test('seek deadlines are not extended by repeated requests and fail the isolated engine', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const a = player.play(path); const b = player.play(path);
  const checked = [a, b].map(p => assert.rejects(p.finished, { code: 'TIMEOUT' }));
  const engine = await started(2);
  engine.event({ type: 'started', id: 1 });
  engine.event({ type: 'started', id: 2 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  a.seek(80);
  t.mock.timers.tick(9999);
  a.seek(0);
  t.mock.timers.tick(1);
  await Promise.all(checked);
  a.seek(2); b.seek(2);
});

test('seek acknowledgments cannot erase stop deadlines, and close ignores seeks', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const checked = assert.rejects(p.finished, { code: 'TIMEOUT' });
  const engine = await started(1);
  engine.event({ type: 'started', id: 1 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  p.seek(2);
  p.stop();
  engine.event({ type: 'seeked', id: 1 });
  t.mock.timers.tick(2000);
  await checked;
  const q = player.play(path);
  q.seek(80);
  const closing = player.close();
  q.seek(0);
  await closing;
  assert.equal(await q.finished, 'stopped');
});

test('one decoder failure does not stop unrelated audio', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const a = player.play(path); const b = player.play(path);
  const rejection = assert.rejects(a.finished, { code: 'DECODE_ERROR' });
  const engine = await started(2);
  engine.event({ type: 'error', id: 1, error: new AudioError('DECODE_ERROR', 'bad data') });
  await rejection;
  engine.event({ type: 'done', id: 2, reason: 'ended' });
  assert.equal(await b.finished, 'ended');
});

test('engine failure rejects all plays and a later call starts a new engine', async t => {
  const { path } = await fixture(t);
  const { player, engines, started } = setup(t);
  const a = player.play(path); const b = player.play(path);
  const checked = [a, b].map(p => assert.rejects(p.finished, { code: 'ENGINE_ERROR' }));
  const engine = await started(2);
  engine.fail(new AudioError('ENGINE_ERROR', 'crash'));
  await Promise.all(checked);
  const c = player.play(path);
  await until(() => engines.length === 2);
  engines[1].event({ type: 'done', id: 3, reason: 'ended' });
  assert.equal(await c.finished, 'ended');
});

test('close prevents in-flight validation from resurrecting an engine', async t => {
  const { path } = await fixture(t);
  const { player, engines } = setup(t);
  const p = player.play(path);
  const close = player.close();
  assert.equal(player.close(), close);
  await close;
  assert.equal(await p.finished, 'stopped');
  await turn();
  assert.equal(engines.length, 0);
  await assert.rejects(player.play(path).finished, { code: 'PLAYER_CLOSED' });
});

test('synchronous initialization failures are engine errors rather than file errors', async t => {
  const { path } = await fixture(t);
  const player = new Controller({}, () => { throw new Error('spawn failed'); });
  t.after(() => player.close());
  await assert.rejects(player.play(path).finished, { code: 'ENGINE_ERROR' });
});

test('close waits for native resources before resolving pending completion', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const engine = await started(1);
  let release;
  engine.close = () => new Promise(resolve => { release = resolve; });
  const close = player.close();
  let finished = false;
  void p.finished.then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  release();
  await close;
  assert.equal(await p.finished, 'stopped');
});

test('idle engine is retired and no permanent timer remains', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = player.play(path);
  const engine = await started(1);
  engine.event({ type: 'done', id: 1, reason: 'ended' });
  await p.finished;
  t.mock.timers.tick(250);
  assert.equal(engine.closed, 1);
  await player.close();
  assert.equal(engine.closed, 1);
});

test('a stuck stop fails all affected plays with a bounded timeout', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const checked = assert.rejects(p.finished, { code: 'TIMEOUT' });
  const engine = await started(1);
  engine.event({ type: 'started', id: 1 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  p.stop();
  t.mock.timers.tick(2000);
  await checked;
  assert.equal(p.state, 'failed');
});

test('pause before dispatch starts paused; repeated commands and timing queries stay bounded', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t, { maxConcurrent: 1 });
  const p = player.play(path);
  p.pause(); p.pause();
  const timing = p.getTiming();
  for (let i = 0; i < 10000; i++) assert.equal(p.getTiming(), timing);
  const engine = await started(1);
  assert.equal(engine.calls[0][4], true);
  engine.event({ type: 'started', id: 1 });
  assert.equal(p.state, 'paused');
  assert.deepEqual(engine.calls.at(-1), ['timing', 1, 1]);
  engine.event({ type: 'timing', id: 1, token: 1, position: 0, duration: null });
  assert.deepEqual(await timing, { position: 0, duration: null });
  assert.ok(Object.isFrozen(await timing));
  await assert.rejects(player.play(path).finished, { code: 'PLAYBACK_LIMIT' });
  p.resume(); p.resume();
  assert.deepEqual(engine.calls.at(-1), ['pause', 1, 2, false]);
  assert.equal(p.state, 'paused');
  engine.event({ type: 'paused', id: 1, token: 2, paused: false });
  assert.equal(p.state, 'playing');
  await player.close();
  assert.equal(await timing, await timing);
  assert.equal(await p.getTiming(), null);
  p.pause(); p.resume();
});

test('pause after dispatch and controls during seek preserve acknowledgment and query ordering', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const engine = await started(1);
  p.pause();
  assert.equal(engine.calls.length, 1);
  engine.event({ type: 'started', id: 1 });
  assert.deepEqual(engine.calls.at(-1), ['pause', 1, 1, true]);
  p.seek(1);
  const timing = p.getTiming();
  p.resume(); p.pause(); p.resume();
  engine.event({ type: 'paused', id: 1, token: 1, paused: true });
  assert.deepEqual(engine.calls.at(-1), ['pause', 1, 3, false]);
  engine.event({ type: 'paused', id: 1, token: 1, paused: true }); // Stale.
  engine.event({ type: 'paused', id: 1, token: 3, paused: false });
  assert.equal(engine.calls.filter(c => c[0] === 'timing').length, 0);
  engine.event({ type: 'seeked', id: 1 });
  assert.deepEqual(engine.calls.at(-1), ['timing', 1, 4]);
  engine.event({ type: 'timing', id: 1, token: 2, position: 99, duration: 100 });
  engine.event({ type: 'timing', id: 1, token: 4, position: 1, duration: 3 });
  assert.deepEqual(await timing, { position: 1, duration: 3 });
  p.pause();
  engine.event({ type: 'paused', id: 1, token: 5, paused: true });
  p.seek(0.5);
  const next = p.getTiming();
  engine.event({ type: 'seeked', id: 1 });
  assert.equal(p.state, 'paused');
  engine.event({ type: 'timing', id: 1, token: 7, position: 0.5, duration: 3 });
  assert.equal((await next).position, 0.5);
});

for (const mode of ['stop', 'abort', 'close', 'ended', 'decode', 'engine']) {
  test(`paused lifecycle settles outstanding timing during ${mode}`, async t => {
    const { path } = await fixture(t);
    const { player, started } = setup(t);
    const signal = new AbortController();
    const p = player.play(path, { signal: signal.signal }); p.pause();
    const engine = await started(1); engine.event({ type: 'started', id: 1 });
    const timing = p.getTiming();
    if (mode === 'decode' || mode === 'engine') {
      const error = new AudioError(mode === 'decode' ? 'DECODE_ERROR' : 'ENGINE_ERROR', 'fault');
      const checks = [assert.rejects(p.finished, { code: error.code }), assert.rejects(timing, { code: error.code })];
      if (mode === 'decode') engine.event({ type: 'error', id: 1, error }); else engine.fail(error);
      await Promise.all(checks);
    } else {
      if (mode === 'close') await player.close();
      else {
        if (mode === 'stop') p.stop();
        if (mode === 'abort') signal.abort();
        engine.event({ type: 'done', id: 1, reason: mode === 'ended' ? 'ended' : 'stopped' });
      }
      assert.equal(await timing, null);
      await p.finished;
    }
    engine.event({ type: 'paused', id: 1, token: 1, paused: false });
    engine.event({ type: 'timing', id: 1, token: 1, position: 88, duration: 99 });
    assert.equal(await p.getTiming(), null);
  });
}

for (const mode of ['pause', 'timing']) {
  test(`${mode} deadline is bounded despite repeated calls and stale responses`, async t => {
    const { path } = await fixture(t);
    const { player, started } = setup(t);
    const p = player.play(path);
    const engine = await started(1); engine.event({ type: 'started', id: 1 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const failure = assert.rejects(p.finished, { code: 'TIMEOUT' });
    let query;
    if (mode === 'pause') p.pause(); else query = assert.rejects(p.getTiming(), { code: 'TIMEOUT' });
    t.mock.timers.tick(9999);
    if (mode === 'pause') { p.pause(); engine.event({ type: 'paused', id: 1, token: 999, paused: true }); }
    else p.getTiming();
    t.mock.timers.tick(1);
    await failure; if (query) await query;
  });
}

test('stale pause and timing acknowledgments cannot clear a stop deadline', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const engine = await started(1); engine.event({ type: 'started', id: 1 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = assert.rejects(p.finished, { code: 'TIMEOUT' });
  const timing = assert.rejects(p.getTiming(), { code: 'TIMEOUT' });
  p.pause(); p.stop();
  engine.event({ type: 'timing', id: 1, token: 1, position: 1, duration: 2 });
  engine.event({ type: 'paused', id: 1, token: 2, paused: true });
  t.mock.timers.tick(2000);
  await Promise.all([failure, timing]);
});

test('stale seek tokens cannot acknowledge a newer seek or release its timing barrier', async t => {
  const { path } = await fixture(t);
  const { player, started } = setup(t);
  const p = player.play(path);
  const engine = await started(1); engine.event({ type: 'started', id: 1 });
  p.seek(1); p.seek(2);
  engine.event({ type: 'seeked', id: 1, token: 1 });
  const query = p.getTiming();
  engine.event({ type: 'seeked', id: 1, token: 1 });
  assert.equal(engine.calls.filter(c => c[0] === 'timing').length, 0);
  engine.event({ type: 'seeked', id: 1, token: 2 });
  engine.event({ type: 'timing', id: 1, token: 3, position: 2, duration: 3 });
  assert.equal((await query).position, 2);
});
