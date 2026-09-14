import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceHash } from './native-manifest.mjs';

const render = process.argv.includes('--render-test');
const test = process.argv.includes('--test') || render;
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const arch = process.env.TARGET_ARCH ?? process.arch;
const directory = test ? '.tmp' : `bin/${platform}-${arch}`;
mkdirSync(directory, { recursive: true });
const output = resolve(directory, `playsound${render ? '-render-test' : test ? '-test' : ''}${platform === 'win32' ? '.exe' : ''}`);
const compiler = process.env.CC ?? (process.platform === 'win32' ? 'clang' : 'cc');
const flags = JSON.parse(process.env.CFLAGS_JSON ?? '[]');
const args = [...flags, '-std=c11', '-O2', '-g0', '-DNDEBUG', ...(test ? ['-DPLAYSOUND_TEST'] : []),
  render ? 'test/render.c' : 'native/player.c', '-o', output, ...(platform === 'win32' ? [] : ['-lpthread', '-lm', ...(platform === 'linux' ? ['-ldl'] : [])])];
const result = spawnSync(compiler, args, { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
// Some Windows compilers emit a sidecar even when debug information is off.
rmSync(output.replace(/\.exe$/, '') + '.pdb', { force: true });
if (!test) writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({
  protocol: 1, platform, arch, sourceSha256: sourceHash(),
  binarySha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
}, null, 2) + '\n');
console.log(output);
