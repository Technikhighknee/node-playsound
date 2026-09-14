import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const targets = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
export const vendorHash = '7e4f3f13c8fe66df2080ac3dd12a89193e3c2463cb7f067c798abd7331cd8ee6';
export function sourceHash() {
  const hash = createHash('sha256');
  for (const path of ['native/player.c', 'native/vendor/miniaudio.h', 'scripts/build-native.mjs']) hash.update(readFileSync(path));
  return hash.digest('hex');
}
