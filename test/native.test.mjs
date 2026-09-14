import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const binary = resolve(`.tmp/playsound-test${process.platform === 'win32' ? '.exe' : ''}`);

async function engine(t) {
  const child = spawn(binary, ['--null', '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); await closed; });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'READY 1', stderr);
  return { child, closed, next: async () => (await lines.next()).value, send: text => child.stdin.write(`${text}\n`) };
}

test('native: concurrent Unicode-path playback completes independently', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 0.15);
  const p = await engine(t);
  p.send(`P 1 0.2 ${Buffer.from(path).toString('hex')}`);
  p.send(`P 2 1 ${Buffer.from(path).toString('hex')}`);
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(await p.next());
  assert.deepEqual(lines.sort(), ['STARTED 1', 'STARTED 2', 'DONE 1 ended', 'DONE 2 ended'].sort());
});

test('native: stop, volume, repeat, and a bad file do not poison the engine', { timeout: 10000 }, async t => {
  const { path, directory } = await fixture(t, 1);
  const broken = join(directory, 'broken.mp3');
  await writeFile(broken, 'not audio');
  const p = await engine(t);
  p.send(`P 1 1 ${Buffer.from(broken).toString('hex')}`);
  assert.match(await p.next(), /^ERROR 1 DECODE -\d+$/);
  for (let id = 2; id < 12; id++) {
    p.send(`P ${id} 0 ${Buffer.from(path).toString('hex')}`);
    assert.equal(await p.next(), `STARTED ${id}`);
    p.send(`V ${id} 0.5`);
    p.send(`S ${id}`);
    assert.equal(await p.next(), `DONE ${id} stopped`);
  }
});

test('native: malformed commands fail closed', { timeout: 10000 }, async t => {
  const p = await engine(t);
  p.send('P 1 nan ff');
  assert.equal((await p.closed)[0], 2);
});

test('native: losing the parent input terminates active audio', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 5);
  const p = await engine(t);
  p.send(`P 1 0 ${Buffer.from(path).toString('hex')}`);
  assert.equal(await p.next(), 'STARTED 1');
  p.child.stdin.end();
  assert.equal((await p.closed)[0], 0);
});

test('native: abrupt parent death leaves no engine process', { timeout: 10000 }, async t => {
  const parent = fork(resolve('test/parent-fixture.mjs'), [binary], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => parent.kill('SIGKILL'));
  const [{ pid }] = await once(parent, 'message');
  const closed = once(parent, 'close');
  parent.kill('SIGKILL');
  await closed;
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(20);
  }
  // Clean up only the exact child created by this test if the assertion fails.
  process.kill(pid, 'SIGKILL');
  assert.fail('native child survived its parent');
});
