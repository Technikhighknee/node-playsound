import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

const binary = resolve(`.tmp/playsound-test${process.platform === 'win32' ? '.exe' : ''}`);

test('native: decoded PCM proves volume, mute, gain changes, and additive mixing', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 0.2);
  const { stdout } = await promisify(execFile)(resolve(`.tmp/playsound-render-test${process.platform === 'win32' ? '.exe' : ''}`),
    [Buffer.from(path).toString('hex')], { windowsHide: true });
  assert.match(stdout, /PCM_OK/);
});

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

for (const format of ['mp3', 'flac']) {
  test(`native: bundled ${format} decoder reaches completion`, { timeout: 10000 }, async t => {
    const p = await engine(t);
    p.send(`P 1 0 ${Buffer.from(resolve(`test/audio/tone.${format}`)).toString('hex')}`);
    assert.equal(await p.next(), 'STARTED 1');
    assert.equal(await p.next(), 'DONE 1 ended');
  });
}

test('native: capacity exhaustion and repeated full batches release every voice', { timeout: 90000 }, async t => {
  const { path } = await fixture(t, 120);
  const p = await engine(t);
  const encoded = Buffer.from(path).toString('hex');
  for (let batch = 0; batch < 2; batch++) {
    const base = batch * 300;
    for (let i = 1; i <= 256; i++) {
      p.send(`P ${base + i} 0 ${encoded}`);
      assert.equal(await p.next(), `STARTED ${base + i}`);
    }
    p.send(`P ${base + 257} 0 ${encoded}`);
    assert.equal(await p.next(), `ERROR ${base + 257} LIMIT 0`);
    for (let i = 1; i <= 256; i++) {
      p.send(`S ${base + i}`);
      assert.equal(await p.next(), `DONE ${base + i} stopped`);
    }
  }
  // A failed allocation must not leave the engine permanently saturated.
  p.send(`P 1000 0 ${encoded}`);
  assert.equal(await p.next(), 'STARTED 1000');
  p.send('S 1000');
  assert.equal(await p.next(), 'DONE 1000 stopped');
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

for (const block of [false, true]) {
  test(`native: forced worker termination ends ${block ? 'blocked' : 'idle'} engine execution`, { timeout: 15000 }, async t => {
    const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url), { workerData: { binary, block } });
    t.after(() => worker.terminate());
    const [{ pid }] = await once(worker, 'message');
    await worker.terminate();
    for (let i = 0; i < 120; i++) {
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      // libuv in a forcibly terminated worker cannot reap its POSIX child.
      // A zombie has exited and released its audio/file/thread resources;
      // the Node parent retains the process record until it exits itself.
      if (process.platform === 'linux') {
        const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        if (!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) return;
      } else if (process.platform === 'darwin') {
        const result = await promisify(execFile)('/bin/ps', ['-o', 'stat=', '-p', String(pid)]).catch(error => {
          if (error.code === 1 && !error.stdout?.trim()) return { stdout: '' };
          throw error;
        });
        if (!result.stdout.trim() || result.stdout.trim().startsWith('Z')) return;
      }
      await delay(100);
    }
    const status = process.platform === 'linux' ? await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'unavailable') : 'unavailable';
    process.kill(pid, 'SIGKILL');
    assert.fail(`native child survived its worker: ${status}`);
  });
}

test('native: cooperative worker shutdown also reaps the engine process', { timeout: 5000 }, async t => {
  const worker = new Worker(new URL('./worker-fixture.mjs', import.meta.url), { workerData: { binary, block: false } });
  t.after(() => worker.terminate());
  const [{ pid }] = await once(worker, 'message');
  const exited = once(worker, 'exit');
  const closed = once(worker, 'message');
  worker.postMessage('close');
  assert.deepEqual(await closed, ['closed']);
  assert.equal((await exited)[0], 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
