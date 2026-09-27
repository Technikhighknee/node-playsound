import { readFileSync, statSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sourceHash, targets, vendorHash } from './native-manifest.mjs';

export function checkPackage(selected = targets) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (pkg.dependencies || pkg.optionalDependencies || pkg.scripts.install || pkg.scripts.postinstall)
    throw new Error('Runtime dependencies and installation scripts are forbidden.');
  if (pkg.type !== 'module' || pkg.license !== 'CC0-1.0') throw new Error('Invalid package contract.');
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  if (digest('native/vendor/miniaudio.h') !== vendorHash) throw new Error('Vendored miniaudio checksum changed. Review and pin the update.');
  for (const target of selected) {
    const [platform, arch] = target.split('-');
    const file = `bin/${target}/playsound${platform === 'win32' ? '.exe' : ''}`;
    let manifest;
    try { manifest = JSON.parse(readFileSync(`bin/${target}/manifest.json`, 'utf8')); }
    catch { throw new Error(`Missing ${target} build. Assemble all six CI artifacts before packing a release.`); }
    if (manifest.protocol !== 4 || manifest.platform !== platform || manifest.arch !== arch || manifest.sourceSha256 !== sourceHash() || manifest.binarySha256 !== digest(file))
      throw new Error(`Stale or mismatched ${target} binary. Rebuild from this exact source tree.`);
    const bytes = readFileSync(file);
    if (platform === 'win32') {
      const pe = bytes.readUInt32LE(0x3c);
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64))
        throw new Error(`Wrong Windows executable architecture: ${target}`);
    } else if (platform === 'linux') {
      if (bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183))
        throw new Error(`Wrong Linux executable architecture: ${target}`);
    } else if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'x64' ? 0x01000007 : 0x0100000c)) {
      throw new Error(`Wrong macOS executable architecture: ${target}`);
    }
    // Artifact transfer commonly drops executable mode; restore before npm pack.
    chmodSync(file, 0o755);
    if (!statSync(file).isFile()) throw new Error(`Not a regular executable: ${file}`);
  }
  console.log(`Validated ${selected.length} native build(s), source hashes, and zero-dependency package contract.`);
}

if (process.argv[1]?.endsWith('check-package.mjs')) checkPackage();
