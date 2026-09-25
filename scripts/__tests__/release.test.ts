import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { touchesDeployConfig } from '../deploy-config.ts';
import { findRelease, main, parseChangelog, releaseNotes } from '../release-notes.ts';

const SAMPLE = `# Changelog

Intro prose.

## [Unreleased]

### Added
- A new thing.

## [1.2.0] - 2026-10-01

### Added
- Second.

### Fixed
- A fix.

## [1.0.0] - 2026-09-23

First release.

[Unreleased]: https://example.test/compare/v1.2.0...HEAD
[1.2.0]: https://example.test/releases/tag/v1.2.0
`;

describe('parseChangelog / findRelease', () => {
  it('splits on release headers and reads the date', () => {
    expect(parseChangelog(SAMPLE).map((r) => [r.version, r.date])).toEqual([
      ['Unreleased', undefined],
      ['1.2.0', '2026-10-01'],
      ['1.0.0', '2026-09-23'],
    ]);
  });

  it('keeps a section to its own body, and drops the trailing link-reference block', () => {
    const last = findRelease(SAMPLE, '1.0.0')!;
    expect(last.body).toBe('First release.');
    expect(findRelease(SAMPLE, '1.2.0')!.body).not.toContain('First release');
  });

  it('accepts a leading v and any case for Unreleased', () => {
    expect(findRelease(SAMPLE, 'v1.2.0')?.version).toBe('1.2.0');
    expect(findRelease(SAMPLE, 'unreleased')?.version).toBe('Unreleased');
    expect(findRelease(SAMPLE, '2.0.0')).toBeUndefined();
  });
});

describe('releaseNotes', () => {
  it('titles the release and demotes headings one level', () => {
    const text = releaseNotes(findRelease(SAMPLE, '1.2.0')!);
    expect(text.startsWith('# 1.2.0 — 2026-10-01\n')).toBe(true);
    expect(text).toContain('\n## Added\n');
    expect(text).toContain('\n## Fixed\n');
    expect(text).not.toContain('### ');
  });
});

describe('main', () => {
  it('prints the requested section, defaulting to Unreleased', () => {
    expect(main([], () => SAMPLE)).toMatchObject({ code: 0 });
    expect(main([], () => SAMPLE).out).toContain('A new thing.');
    expect(main(['1.0.0'], () => SAMPLE).out).toContain('First release.');
  });

  it('fails clearly for a missing or empty section', () => {
    expect(main(['9.9.9'], () => SAMPLE)).toMatchObject({ code: 1 });
    expect(main([], () => '## [Unreleased]\n\n## [1.0.0] - 2026-09-23\nx\n')).toMatchObject({ code: 1 });
  });
});

describe('the real CHANGELOG.md', () => {
  const real = readFileSync('CHANGELOG.md', 'utf-8');

  it('has a non-empty Unreleased section and a 1.0.0 section', () => {
    expect(findRelease(real, 'Unreleased')!.body.length).toBeGreaterThan(100);
    expect(findRelease(real, '1.0.0')!.date).toBe('2026-09-23');
  });

  it('produces notes for every release it lists, none empty', () => {
    for (const r of parseChangelog(real)) expect(r.body.length, r.version).toBeGreaterThan(0);
  });
});

describe('touchesDeployConfig', () => {
  it('flags the files only a real deploy can prove', () => {
    const hits = touchesDeployConfig(['wrangler.jsonc', 'public/_headers', 'public/fonts/x.woff2', 'index.html', 'pnpm-workspace.yaml', '.node-version']);
    expect(hits.map((h) => h.file)).toEqual(['wrangler.jsonc', 'public/_headers', 'public/fonts/x.woff2', 'index.html', 'pnpm-workspace.yaml', '.node-version']);
    expect(hits.every((h) => h.why.length > 10)).toBe(true);
  });

  it('ignores ordinary source and docs', () => {
    expect(touchesDeployConfig(['src/engine/runQuery.ts', 'README.md', 'plan.md', 'publicity.md', 'src/public/x.ts'])).toEqual([]);
  });
});
