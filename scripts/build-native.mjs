import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, basename } from 'node:path';
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
if (!Array.isArray(flags) || !flags.every(flag => typeof flag === 'string')) throw new Error('CFLAGS_JSON must be an array of arguments.');
if (!test && flags.some(flag => flag.includes('PLAYSOUND_TEST'))) throw new Error('The test backend cannot be enabled in production builds.');
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported native architecture: ${arch}`);
// zig cc otherwise targets the build host's CPU, including optional features
// that consumer machines may not support. Set the baseline for every build,
// including tests, and apply it after caller flags so -mcpu=native cannot win.
const cpuFlags = /^zig(?:\.exe)?$/i.test(basename(compiler))
  ? ['-mcpu=baseline']
  : [arch === 'x64' ? '-march=x86-64' : '-march=armv8-a'];
const args = [...flags, ...cpuFlags, '-std=c11', '-O2', '-g0', '-DNDEBUG', ...(test ? ['-DPLAYSOUND_TEST'] : []),
  render ? 'test/render.c' : 'native/player.c', 'native/identity.c', '-o', output, ...(platform === 'win32' ? ['-lole32'] : ['-lpthread', '-lm', ...(platform === 'linux' ? ['-ldl'] : [])])];
const result = spawnSync(compiler, args, { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
// Some Windows compilers emit a sidecar even when debug information is off.
rmSync(output.replace(/\.exe$/, '') + '.pdb', { force: true });
writeFileSync(test ? `${output}.json` : resolve(directory, 'manifest.json'), JSON.stringify({
  protocol: 4, platform, arch, sourceSha256: sourceHash(),
  ...(render ? { renderSha256: createHash('sha256').update(readFileSync('test/render.c')).digest('hex') } : {}),
  binarySha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
}, null, 2) + '\n');
console.log(output);
if (test && !render && platform === 'win32') {
  const probe = spawnSync(compiler, [...flags, ...cpuFlags, '-std=c11', '-O2',
    'test/identity-windows.c', 'native/identity.c', '-lole32', '-o', resolve('.tmp/identity-probe.exe')],
    { stdio: 'inherit', windowsHide: true });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) process.exit(probe.status ?? 1);
}
