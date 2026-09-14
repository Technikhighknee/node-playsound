import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const test = process.argv.includes('--test');
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const arch = process.env.TARGET_ARCH ?? process.arch;
const directory = test ? '.tmp' : `bin/${platform}-${arch}`;
mkdirSync(directory, { recursive: true });
const output = resolve(directory, `playsound${test ? '-test' : ''}${platform === 'win32' ? '.exe' : ''}`);
const compiler = process.env.CC ?? 'cc';
const flags = JSON.parse(process.env.CFLAGS_JSON ?? '[]');
const args = [...flags, '-std=c11', '-O2', '-DNDEBUG', ...(test ? ['-DPLAYSOUND_TEST'] : []),
  'native/player.c', '-o', output, ...(platform === 'win32' ? [] : ['-lpthread', '-lm', ...(platform === 'linux' ? ['-ldl'] : [])])];
const result = spawnSync(compiler, args, { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
console.log(output);
