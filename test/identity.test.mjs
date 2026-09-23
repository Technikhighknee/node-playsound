import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationName } from '../dist/identity.js';
import { Controller } from '../dist/player.js';
import { Player } from '../dist/index.js';
import { fixture } from './fixtures.mjs';

test('application identity defaults to a filename without probing packages or exposing paths', () => {
  assert.equal(applicationName(undefined, join('private', 'music app.mjs'), 'node'), 'music app.mjs');
  assert.equal(applicationName(undefined, '', process.execPath), basename(process.execPath));
  assert.equal(applicationName(undefined, 'bad\nname', 'node'), 'Node.js');
  assert.equal(applicationName(undefined, 'x'.repeat(256), 'node'), 'Node.js');
});

test('application names are bounded, lossless Unicode labels', async () => {
  for (const name of ['My app', '音 🎵', 'a'.repeat(255), '音'.repeat(85), '" & --null']) {
    assert.equal(applicationName(name), name);
    await new Player({ applicationName: name }).close();
  }
  for (const name of [null, 1, {}, '', ' ', '\u3000', '\ufeff', 'bad\0name', '\n', '\u0085',
    '\ud800', '\udfff', 'x'.repeat(256), '音'.repeat(86)]) {
    assert.throws(() => new Player({ applicationName: name }), /applicationName/);
  }
});

test('independent players capture names once and preserve them across idle restarts', { timeout: 5000 }, async t => {
  const { path } = await fixture(t);
  const calls = [];
  const original = process.argv[1];
  const factory = (event, _failed, name) => {
    calls.push(name);
    return {
      play(id) { queueMicrotask(() => event({ type: 'done', id, reason: 'ended' })); },
      close: async () => {},
    };
  };
  const inferred = new Controller({}, factory);
  const explicit = new Controller({ applicationName: '音 app' }, factory);
  t.after(async () => { process.argv[1] = original; await inferred.close(); await explicit.close(); });
  process.argv[1] = 'changed.mjs';
  await Promise.all([inferred.play(path).finished, explicit.play(path).finished]);
  await delay(350);
  await inferred.play(path).finished;
  assert.deepEqual(calls.slice(0, 2).sort(), [basename(original), '音 app'].sort());
  assert.deepEqual(calls.slice(2), [basename(original)]);
});
