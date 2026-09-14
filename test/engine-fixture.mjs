// A deliberately adversarial subprocess for exercising the real pipe transport.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
if (mode === 'exit') process.exit(17);
if (mode === 'oversize') process.stdout.write('x'.repeat(1024));
else if (mode === 'garbage') process.stdout.write('READY 2\n');
else if (mode === 'device') process.stdout.write('FATAL DEVICE -401\n');
else if (mode !== 'hang') {
  process.stdout.write('REA');
  setTimeout(() => process.stdout.write('DY 1\n'), 5);
}
const keepalive = setInterval(() => {}, 1000);
const reader = createInterface({ input: process.stdin });
reader.on('close', () => { clearInterval(keepalive); });
reader.on('line', line => {
  const [op, id] = line.split(' ');
  if (op === 'QUIT') process.exit(0);
  if (op === 'P') {
    if (mode === 'crash') process.exit(23);
    if (mode === 'duplicate') process.stdout.write('READY 1\n');
    else process.stdout.write(`STARTED ${id}\nDONE ${id} ended\n`);
  }
});
