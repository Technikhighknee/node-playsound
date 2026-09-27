import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn(workerData.binary, ['--null', '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
createInterface({ input: child.stdout }).on('line', line => {
  if (line === 'READY 4' && workerData.block) child.stdin.write('BLOCK\nS 1\n');
  if ((line === 'READY 4' && !workerData.block) || line === 'BLOCKED')
    setTimeout(() => parentPort.postMessage({ pid: child.pid }), 50);
});
parentPort.on('message', message => {
  if (message !== 'close') return;
  child.once('close', () => {
    parentPort.postMessage('closed');
    parentPort.close();
  });
  child.stdin.end();
});
