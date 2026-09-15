import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join, relative } from 'node:path';
import ts from 'typescript';

// Documentation snippets compile against the package's public exports, not src
// internals. No audio is started and no external links are requested in CI.
const root = process.cwd();
const files = ['README.md', 'CHANGELOG.md', ...readdirSync('docs').filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
const withoutCode = text => text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
function anchors(text) {
  const found = new Set();
  const counts = new Map();
  for (const match of withoutCode(text).matchAll(/^#{1,6} +(.+)$/gm)) {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) ?? 0;
    found.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return found;
}
mkdirSync('.tmp', { recursive: true });
const temporary = mkdtempSync(resolve('.tmp/docs-'));
const snippets = [];
let links = 0;
try {
  for (const file of files) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    for (const match of withoutCode(text).matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      const [path, fragment] = href.split('#');
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
      if (!existsSync(target)) throw new Error(`${file}: missing link target ${href}`);
      if (fragment && statSync(target).isFile() && !anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment)))
        throw new Error(`${file}: missing heading ${href}`);
      links++;
    }
    let block = 0;
    for (const match of text.matchAll(/```ts\r?\n([\s\S]*?)```/g)) {
      const output = join(temporary, `${file.replace(/[/.]/g, '-')}-${++block}.mts`);
      writeFileSync(output, match[1]);
      snippets.push(output);
    }
  }
  const program = ts.createProgram(snippets, {
    noEmit: true, strict: true, skipLibCheck: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, types: ['node'],
    lib: ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: file => relative(root, file), getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  console.log(`Verified ${snippets.length} TypeScript documentation examples and ${links} local links.`);
} finally {
  if (dirname(resolve(temporary)) !== resolve(root, '.tmp') || !basename(temporary).startsWith('docs-'))
    throw new Error('Refusing to clean an unexpected documentation directory.');
  rmSync(temporary, { recursive: true, force: true });
}
