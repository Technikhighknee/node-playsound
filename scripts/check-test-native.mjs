import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sourceHash } from './native-manifest.mjs';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const name of ['test', 'render-test']) {
  const file = `.tmp/playsound-${name}${process.platform === 'win32' ? '.exe' : ''}`;
  try {
    const manifest = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.sourceSha256 !== sourceHash() || manifest.binarySha256 !== digest(file) ||
        (name === 'render-test' && manifest.renderSha256 !== digest('test/render.c'))) throw new Error('stale');
  } catch {
    throw new Error(`Missing or stale ${name} executable. Run npm run build:test-native with a C11 compiler before testing.`);
  }
}
