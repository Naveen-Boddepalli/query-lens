/**
 * plan.md §H3. Builds the two packages this repository publishes into their own `dist` directories:
 *
 *   @querylens/engine   packages/engine   the engine alone, for other programs
 *   querylens           packages/cli      the terminal trace, with its own copy of the engine so `npx querylens` needs
 *                                         nothing else installed
 *   @querylens/mcp      packages/mcp      the engine as a Model Context Protocol server, with its own copy of the engine
 *
 *   pnpm build:packages
 *
 * TypeScript rewrites the `.ts` import specifiers in the JavaScript it emits, but not in the declaration files, which
 * a NodeNext consumer would then fail to resolve. This rewrites those, copies the licence in, gives the CLI a plain
 * `node` shebang, and refuses to finish if a test file or a `.ts` specifier got into an output.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const tsc = join(root, 'node_modules', '.bin', 'tsc');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function buildPackage(pkg: string): void {
  const dir = join(root, 'packages', pkg);
  const dist = join(dir, 'dist');
  execFileSync(tsc, ['-p', join(dir, 'tsconfig.build.json')], { stdio: 'inherit' });

  const specifier = /(['"])(\.\.?\/[^'"]*?)\.ts\1/g;
  let rewritten = 0;
  for (const file of walk(dist).filter((f) => f.endsWith('.d.ts'))) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(specifier, (_m, q: string, path: string) => `${q}${path}.js${q}`);
    if (after !== before) {
      writeFileSync(file, after);
      rewritten++;
    }
  }

  for (const entry of [join(dist, 'bin', 'querylens.js'), join(dist, 'mcp', 'server.js')]) {
    try {
      const source = readFileSync(entry, 'utf8');
      writeFileSync(entry, source.replace(/^#!.*\n/, '#!/usr/bin/env node\n'));
    } catch {
      // Not every package has this entry point.
    }
  }

  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));

  const leftovers = walk(dist)
    .filter((f) => /\.(d\.ts|js)$/.test(f))
    .filter((f) => /from '[^']*\.ts'|from "[^"]*\.ts"|import\('[^']*\.ts'\)|vitest|fast-check/.test(readFileSync(f, 'utf8')));
  const tests = walk(dist).filter((f) => f.includes('__tests__'));
  if (leftovers.length > 0 || tests.length > 0) {
    throw new Error(`${pkg} still contains ${[...leftovers, ...tests].map((f) => relative(dir, f)).join(', ')}`);
  }
  console.log(`${pkg}: ${String(walk(dist).length)} files, ${String(rewritten)} declaration files rewritten.`);
}

buildPackage('engine');
buildPackage('cli');
buildPackage('mcp');
