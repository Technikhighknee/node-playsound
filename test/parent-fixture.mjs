import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], ['--null', '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
child.stdout.once('data', () => process.send({ pid: child.pid }));
setInterval(() => {}, 1000);
