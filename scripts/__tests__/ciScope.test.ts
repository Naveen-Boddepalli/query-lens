import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ciScope, hasNoCiEffect, MARKDOWN_UNDER_TEST } from '../ci-scope.ts';

describe('ciScope', () => {
  it('skips everything for a docs-only change', () => {
    expect(ciScope(['README.md', 'docs/tasks/T1.md', 'packages/cli/README.md', '.github/PULL_REQUEST_TEMPLATE.md', 'LICENSE'])).toEqual({ code: false, e2e: false });
  });

  it('runs everything when the file list is empty — the diff could not be worked out', () => {
    expect(ciScope([])).toEqual({ code: true, e2e: true });
    expect(ciScope(['', '  '])).toEqual({ code: true, e2e: true });
  });

  it('treats Markdown a test reads as code', () => {
    expect(ciScope(['STUDY.md'])).toEqual({ code: true, e2e: true });
    expect(ciScope(['CHANGELOG.md'])).toEqual({ code: true, e2e: true });
  });

  it('treats docs pages as code: .mdx is compiled into the app', () => {
    expect(ciScope(['src/pages/DocsContent/faq.mdx'])).toEqual({ code: true, e2e: true });
  });

  it('skips only the Playwright shards for code the browser never loads', () => {
    expect(ciScope(['oracle/model.ts', 'bin/querylens.ts', 'mcp/server.ts', 'scripts/study.ts', 'README.md'])).toEqual({ code: true, e2e: false });
  });

  it('runs everything for app code, config, the lockfile, and ci.yml itself', () => {
    for (const file of ['src/App.tsx', 'e2e/smoke.spec.ts', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'public/_headers', '.github/workflows/ci.yml']) {
      expect(ciScope([file]), file).toEqual({ code: true, e2e: true });
    }
  });

  it('runs everything for a path neither list names', () => {
    expect(ciScope(['something-new.toml'])).toEqual({ code: true, e2e: true });
  });

  it('prints GITHUB_OUTPUT lines from the command line', () => {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/ci-scope.ts', 'README.md', 'bin/querylens.ts'], { encoding: 'utf-8' });
    expect(out.trim().split('\n')).toEqual(['code=true', 'e2e=false']);
  });

  it('reads the file list from stdin with --stdin, and an empty list runs everything', () => {
    const run = (input: string) => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/ci-scope.ts', '--stdin'], { input, encoding: 'utf-8' }).trim().split('\n');
    expect(run('README.md\ndocs/LESSONS.md\n')).toEqual(['code=false', 'e2e=false']);
    expect(run('\n')).toEqual(['code=true', 'e2e=true']);
  });
});

describe('MARKDOWN_UNDER_TEST', () => {
  it('lists every Markdown file the code reads', () => {
    const readers = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { encoding: 'utf-8' }).split('\n').filter((f) => f !== '');
    const read = readers.flatMap((f) => [...readFileSync(f, 'utf-8').matchAll(/readFileSync\(\s*['"`]([^'"`]+\.md)['"`]/g)].map((m) => m[1] ?? ''));
    expect(read.length).toBeGreaterThan(0);
    for (const file of read) expect(hasNoCiEffect(file), file).toBe(false);
    for (const file of MARKDOWN_UNDER_TEST) expect(read).toContain(file);
  });
});
