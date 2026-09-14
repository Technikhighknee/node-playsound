import { checkPackage } from './check-package.mjs';
import { packArchive } from './archive.mjs';

checkPackage();
const packed = packArchive(process.cwd());
console.log(`${packed.filename}: ${packed.entryCount} files, ${packed.size} bytes\n${packed.integrity}`);
