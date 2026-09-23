// Real OS metadata integration check; requires a Windows output or PulseAudio server.
// Not a null-backend test, and never installed with the package.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

if (!['win32', 'linux'].includes(process.platform)) throw new Error('This platform has no supported audio label API.');
const binary = resolve(process.argv[2] ?? `bin/${process.platform}-${process.arch}/playsound${process.platform === 'win32' ? '.exe' : ''}`);
const children = [];
try {
  for (const name of ['Identity test 音 🎵', 'Independent app', 'Identity test 音 🎵']) {
    const child = spawn(binary, ['--parent', String(process.pid), '--application-name', Buffer.from(name).toString('hex')],
      { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const closed = once(child, 'close');
    const deadline = setTimeout(() => child.kill(), 15000);
    child.stdin.on('error', () => {});
    children.push({ child, closed, name, deadline });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, 'READY 4');
    // Recheck every independent session after creating another one.
    for (const active of children) {
      if (process.platform === 'win32') {
        execFileSync(resolve('.tmp/identity-probe.exe'), [String(active.child.pid), Buffer.from(active.name).toString('hex')],
          { stdio: 'inherit', windowsHide: true, timeout: 5000 });
      } else {
        // PulseAudio 15's JSON encoder rejects non-ASCII strings. Its text
        // property output preserves UTF-8; use a fixed locale for section names.
        const output = execFileSync('pactl', ['list', 'sink-inputs'], {
          encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C.UTF-8' },
        });
        const streams = output.split(/^Sink Input #/m).slice(1).map(block =>
          Object.fromEntries([...block.matchAll(/^\s+([\w.-]+) = "(.*)"$/gm)].map(m => [m[1], m[2]])));
        const own = streams.filter(s => s['application.process.id'] === String(active.child.pid));
        assert.equal(own.length, 1);
        assert.equal(own[0]['application.name'], active.name);
        assert.equal(own[0]['media.name'], active.name);
      }
    }
  }
  console.log('Independent application labels verified through OS metadata.');
} finally {
  for (const { child } of children) child.stdin.end('QUIT\n');
  await Promise.all(children.map(async ({ child, closed, deadline }) => {
    clearTimeout(deadline);
    const timer = setTimeout(() => child.kill(), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  }));
}
