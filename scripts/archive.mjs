import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const nativePath = /^package\/bin\/(win32|darwin|linux)-(x64|arm64)\/playsound(?:\.exe)?$/;
const field = (header, start, length) => header.toString('utf8', start, start + length).split('\0')[0];

// npm writes 0644 for executable files on Windows. Normalize only the six
// private native entries in its ustar archive; no custom file selection or
// installation script is needed. All other npm metadata is preserved.
export function normalizeArchive(compressed) {
  const tar = gunzipSync(compressed);
  const executables = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const prefix = field(header, 345, 155);
    const path = `${prefix ? prefix + '/' : ''}${field(header, 0, 100)}`;
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error('npm produced an invalid tar entry.');
    if (nativePath.test(path)) {
      if (header[156] !== 0 && header[156] !== 48) throw new Error('Native executable is not a regular archive entry.');
      header.write('0000755\0', 100, 8, 'ascii');
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      executables.push(path.slice('package/'.length));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { compressed: gzipSync(tar, { level: 9 }), executables };
}

export function packArchive(destination) {
  if (!process.env.npm_execpath) throw new Error('Run packaging through npm.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stdout}\n${result.stderr}`);
  const metadata = JSON.parse(result.stdout)[0];
  const file = join(destination, metadata.filename);
  const archive = normalizeArchive(readFileSync(file));
  const expected = metadata.files.filter(entry => /^bin\/[^/]+\/playsound(?:\.exe)?$/.test(entry.path));
  if (expected.length !== archive.executables.length || expected.some(entry => !archive.executables.includes(entry.path)))
    throw new Error('Could not locate every native executable in the npm archive.');
  writeFileSync(file, archive.compressed);
  metadata.size = archive.compressed.length;
  metadata.shasum = createHash('sha1').update(archive.compressed).digest('hex');
  metadata.integrity = `sha512-${createHash('sha512').update(archive.compressed).digest('base64')}`;
  for (const entry of expected) entry.mode = 0o755;
  return metadata;
}
