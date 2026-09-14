import { checkPackage } from './check-package.mjs';

checkPackage();
if (process.platform === 'win32')
  throw new Error('Use npm run package on Windows to preserve Unix executable permissions in the release archive.');
