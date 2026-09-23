import { basename } from 'node:path';

/** A label, never a command line, package search, or full path. */
export function applicationName(value: unknown, entry = process.argv[1], executable = process.execPath): string {
  if (value === undefined) {
    const inferred = basename(entry || executable);
    return valid(inferred) ? inferred : 'Node.js';
  }
  if (typeof value !== 'string' || !valid(value))
    throw new TypeError('applicationName must be nonblank Unicode without control characters, at most 255 UTF-8 bytes.');
  return value;
}

function valid(value: string): boolean {
  const bytes = Buffer.from(value, 'utf8');
  return value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    bytes.length <= 255 && bytes.toString('utf8') === value;
}
