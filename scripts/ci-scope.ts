#!/usr/bin/env -S node --experimental-strip-types
/**
 * Which CI jobs a change set needs, so a README typo does not cost three Playwright shards.
 *
 *   node --experimental-strip-types scripts/ci-scope.ts <changed files…>
 *   git diff --name-only … | node --experimental-strip-types scripts/ci-scope.ts --stdin
 *
 * prints `code=true|false` and `e2e=true|false`, one per line, in the shape `$GITHUB_OUTPUT` reads.
 *
 *   code — typecheck, lint, unit, build/budget and CLI smoke tests. False only when every file is in
 *          NO_CI_EFFECT: prose, licences, issue templates — nothing any check reads.
 *   e2e  — the Playwright shards. Also false when the remaining files are all in NOT_IN_THE_APP: code the
 *          browser bundle never imports and `e2e/` never runs (the oracle, the CLI, the MCP server, the
 *          package wrappers, the build scripts). The cheaper jobs still check those.
 *
 * It fails open: an empty file list (the diff could not be worked out) or any path neither list names runs
 * everything. A new kind of file costs CI minutes until it is listed here, never a missed check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Markdown that a test reads, so it is code as far as CI is concerned. Keep in step with the
 * `readFileSync('….md')` calls in `scripts/__tests__/`, `oracle/` and `e2e/`.
 */
export const MARKDOWN_UNDER_TEST: readonly string[] = [
  'STUDY.md', // scripts/__tests__/study.test.ts, e2e/study.spec.ts
  'CHANGELOG.md', // scripts/__tests__/release.test.ts
];

/** Paths (or prefixes ending in `/`) no CI job reads. `*.md` is handled separately, minus MARKDOWN_UNDER_TEST. */
export const NO_CI_EFFECT: readonly string[] = [
  'docs/',
  '.claude/',
  '.github/ISSUE_TEMPLATE/',
  '.github/dependabot.yml',
  // Workflows ci.yml does not run; a change to ci.yml itself runs everything.
  '.github/workflows/oracle.yml',
  '.github/workflows/publish-packages.yml',
  'LICENSE',
  'LICENSE-DOCS',
  'NOTICE',
];

/** Paths the browser bundle never imports and `e2e/` never touches. */
export const NOT_IN_THE_APP: readonly string[] = ['oracle/', 'bin/', 'mcp/', 'packages/', 'scripts/'];

const matches = (file: string, rules: readonly string[]): boolean =>
  rules.some((rule) => (rule.endsWith('/') ? file.startsWith(rule) : file === rule));

export function hasNoCiEffect(file: string): boolean {
  if (file.endsWith('.md')) return !MARKDOWN_UNDER_TEST.includes(file);
  return matches(file, NO_CI_EFFECT);
}

export function ciScope(files: readonly string[]): { code: boolean; e2e: boolean } {
  const changed = files.map((f) => f.trim()).filter((f) => f !== '');
  if (changed.length === 0) return { code: true, e2e: true };
  const code = changed.filter((f) => !hasNoCiEffect(f));
  return { code: code.length > 0, e2e: code.some((f) => !matches(f, NOT_IN_THE_APP)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `--stdin` reads one path per line, so a long list is classified in one go rather than split by xargs.
  const args = process.argv.slice(2);
  const files = args[0] === '--stdin' ? readFileSync(0, 'utf-8').split('\n') : args;
  const { code, e2e } = ciScope(files);
  console.log(`code=${code}`);
  console.log(`e2e=${e2e}`);
}
