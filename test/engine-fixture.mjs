// A deliberately adversarial subprocess for exercising the real pipe transport.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const mode = process.argv[2];
if (mode === 'exit') process.exit(17);
if (mode === 'oversize') process.stdout.write('x'.repeat(1024));
else if (mode === 'garbage') process.stdout.write('READY 1\n');
else if (mode === 'device') process.stdout.write('FATAL DEVICE -401\n');
else if (mode === 'decoder-timeout') process.stdout.write('FATAL TIMEOUT 0\n');
else if (mode !== 'hang') {
  process.stdout.write('REA');
  setTimeout(() => process.stdout.write('DY 4\n'), 5);
}
const keepalive = setInterval(() => {}, 1000);
const reader = createInterface({ input: process.stdin });
reader.on('close', () => { clearInterval(keepalive); });
reader.on('line', line => {
  const [op, id] = line.split(' ');
  if (op === 'QUIT') process.exit(0);
  if (mode === 'backpressure') {
    if (op === 'P') {
      if (id === '1') {
        const gate = Buffer.from(line.split(' ')[3], 'hex').toString();
        reader.pause();
        const resume = setInterval(() => {
          if (existsSync(gate)) { clearInterval(resume); reader.resume(); }
        }, 5);
        reader.once('close', () => clearInterval(resume));
      }
      process.stdout.write(`STARTED ${id}\n`);
    }
    if (op === 'A') process.stdout.write(`PAUSED ${id} ${line.split(' ')[2]} ${line.split(' ')[3]}\n`);
    if (op === 'T') process.stdout.write(`TIMING ${id} ${line.split(' ')[2]} 0 1\n`);
    if (op === 'Q') process.stdout.write(`SEEKED ${id} ${line.split(' ')[3]}\n`);
    if (op === 'S') process.stdout.write(`DONE ${id} stopped\n`);
    return;
  }
  if (op === 'P') {
    if (mode.startsWith('response:')) { process.stdout.write(mode.slice(9) + '\n'); return; }
    if (mode === 'crash') process.exit(23);
    if (mode === 'duplicate') process.stdout.write('READY 4\n');
    else process.stdout.write(`STARTED ${id}\nDONE ${id} ended\n`);
  }
});
