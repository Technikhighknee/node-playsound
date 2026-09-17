import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fixture, wav } from './fixtures.mjs';
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

for (const mode of ['seek', 'fail-seek', 'fail-read', 'unknown-length']) {
  test(`native: seeking PCM and decoder error propagation (${mode})`, { timeout: 10000 }, async t => {
    const { path } = await fixture(t, 1);
    const data = wav(1);
    data.fill(0, 44, 44 + 48000); // Silence until 0.5 seconds, then tone.
    await writeFile(path, data);
    const { stdout } = await promisify(execFile)(resolve(`.tmp/playsound-render-test${process.platform === 'win32' ? '.exe' : ''}`),
      [Buffer.from(path).toString('hex'), mode], { windowsHide: true, timeout: 8000 });
    if (mode === 'seek') assert.match(stdout, /SEEK_PCM_OK/);
    else {
      assert.match(stdout, /ERROR 1 DECODE -\d+/);
      assert.doesNotMatch(stdout, /SEEKED 1|DONE 1 ended/);
      assert.match(stdout, /SEEK_FAILURE_OK/);
    }
  });
}

for (const rate of [48000, 24000]) for (const mode of ['seek-refill', 'close-refill', 'stale-error']) {
  test(`native: bounded streaming workers preserve PCM and lifetime (${mode}, ${rate} Hz)`, { timeout: 10000 }, async t => {
    const { path } = await fixture(t, 4);
    const data = wav(4);
    data.writeUInt32LE(rate, 24);
    data.writeUInt32LE(rate * 2, 28); // Exercise conversion from mono at another sample rate.
    for (let frame = 0; frame < 48000 * 4; frame++) data.writeInt16LE((frame * 137 % 65536) - 32768, 44 + frame * 2);
    await writeFile(path, data);
    const { stdout } = await promisify(execFile)(resolve(`.tmp/playsound-render-test${process.platform === 'win32' ? '.exe' : ''}`),
      [Buffer.from(path).toString('hex'), mode], { windowsHide: true, timeout: 8000 });
    assert.match(stdout, /STREAM_OK/);
  });
}

test('native: a stalled background decoder exits with a bounded timeout', { timeout: 15000 }, async t => {
  const { path } = await fixture(t, 1);
  await assert.rejects(promisify(execFile)(resolve(`.tmp/playsound-render-test${process.platform === 'win32' ? '.exe' : ''}`),
    [Buffer.from(path).toString('hex'), 'stall'], { windowsHide: true, timeout: 13000 }), error => {
    assert.equal(error.code, 3);
    assert.match(error.stdout, /FATAL TIMEOUT 0/);
    return true;
  });
});

async function engine(t) {
  const child = spawn(binary, ['--null', '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); await closed; });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'READY 3', stderr);
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

for (const format of ['wav', 'mp3', 'flac']) {
  test(`native: streamed ${format} seeks forward, backward, and beyond the end`, { timeout: 10000 }, async t => {
    const { path } = await fixture(t, 2);
    const source = format === 'wav' ? path : resolve(`test/audio/tone.${format}`);
    const p = await engine(t);
    p.send(`P 1 0 ${Buffer.from(source).toString('hex')}`);
    assert.equal(await p.next(), 'STARTED 1');
    for (const seconds of [0.05, 0]) {
      p.send(`Q 1 ${seconds} 1`);
      assert.equal(await p.next(), 'SEEKED 1 1');
    }
    p.send('Q 1 1.7976931348623157e+308 1');
    assert.equal(await p.next(), 'DONE 1 ended');
    p.send('Q 1 0 1'); // Already completed: no resurrection or stale reply.
    p.send(`P 2 0 ${Buffer.from(path).toString('hex')}`);
    assert.equal(await p.next(), 'STARTED 2');
    p.send('S 2');
    assert.equal(await p.next(), 'DONE 2 stopped');
  });
}

test('native: capacity exhaustion and repeated full batches release every voice', { timeout: 90000 }, async t => {
  const { path } = await fixture(t, 120);
  const p = await engine(t);
  const encoded = Buffer.from(path).toString('hex');
  for (let batch = 0; batch < 2; batch++) {
    const base = batch * 300;
    for (let i = 1; i <= 256; i++) {
      p.send(`${batch ? 'B' : 'P'} ${base + i} 0 ${encoded}`);
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

for (const value of ['-1', 'nan', 'inf', '1 trailing']) {
  test(`native: malformed seek fails closed (${value})`, { timeout: 10000 }, async t => {
    const p = await engine(t);
    p.send(`Q 1 ${value} 1`);
    assert.equal((await p.closed)[0], 2);
  });
}

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

test('native: offline pause timing proves cursor, seek, starvation, peers, and failure ownership', { timeout: 10000 }, async t => {
  const { path } = await fixture(t, 3);
  const { stdout } = await promisify(execFile)(resolve(`.tmp/playsound-render-test${process.platform === 'win32' ? '.exe' : ''}`),
    [Buffer.from(path).toString('hex'), 'pause-timing'], { windowsHide: true, timeout: 8000 });
  assert.match(stdout, /TIMING 1 1 0 3/);
  assert.match(stdout, /TIMING 1 8 1.25 3/);
  assert.match(stdout, /TIMING 1 8 0.25 3/);
  assert.match(stdout, /TIMING 1 9 0.25 -/);
  assert.match(stdout, /ERROR 1 DECODE/);
  assert.match(stdout, /PAUSE_TIMING_OK/);
});

for (const format of ['wav', 'mp3', 'flac']) {
  test(`native: paused ${format} reports duration, seeks, resumes, and ends`, { timeout: 10000 }, async t => {
    const { path } = await fixture(t, 0.2);
    const source = format === 'wav' ? path : resolve(`test/audio/tone.${format}`);
    const p = await engine(t);
    p.send(`B 1 0 ${Buffer.from(source).toString('hex')}`);
    assert.equal(await p.next(), 'STARTED 1');
    p.send('T 1 1');
    const timing = (await p.next()).split(' ');
    assert.deepEqual(timing.slice(0, 4), ['TIMING', '1', '1', '0']);
    assert.ok(Number(timing[4]) > 0.1 && Number(timing[4]) < 0.5);
    await delay(50);
    p.send('T 1 2');
    assert.equal((await p.next()).split(' ')[3], '0');
    p.send('Q 1 0.05 3'); assert.equal(await p.next(), 'SEEKED 1 3');
    p.send('T 1 4'); assert.ok(Math.abs(Number((await p.next()).split(' ')[3]) - 0.05) < 0.0001);
    p.send('A 1 5 0'); assert.equal(await p.next(), 'PAUSED 1 5 0');
    assert.equal(await p.next(), 'DONE 1 ended');
    p.send('A 1 6 0'); // Completed handles never restart.
  });
}

for (const command of ['A 1 0 1', 'A 1 1 2', 'A 1 1 1 extra', 'T 1 9007199254740992', 'T 1 1 extra']) {
  test(`native: malformed pause/timing command fails closed (${command})`, { timeout: 5000 }, async t => {
    const p = await engine(t);
    p.send(command);
    assert.equal((await p.closed)[0], 2);
  });
}
