import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const targets = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
export const vendorHash = '3c74bef57ad30f4ad56c644b0441c5a9d73d25f977707093537620b382ea0b46';
export function sourceHash() {
  const hash = createHash('sha256');
  for (const path of ['native/player.c', 'native/vendor/miniaudio.h', 'scripts/build-native.mjs']) hash.update(readFileSync(path));
  return hash.digest('hex');
}
