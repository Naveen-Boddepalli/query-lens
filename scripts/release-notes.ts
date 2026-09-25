#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pnpm release-notes [version]` — the GitHub release body for a version,
 * taken from CHANGELOG.md (plan.md §25.4 A4).
 *
 * The CHANGELOG is the one place release notes are written; a release's body is
 * *derived* from it, never retyped, so the two cannot disagree. With no
 * argument it prints `[Unreleased]` — the notes for the release about to be cut.
 *
 *   pnpm release-notes            # the notes for what is about to ship
 *   pnpm release-notes 1.0.0      # a past release
 *   pnpm release-notes 1.0.0 | gh release create v1.0.0 --notes-file -
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Release {
  /** `Unreleased`, or a semver like `1.0.0`. */
  version: string;
  /** `YYYY-MM-DD` from the header, when it has one. */
  date?: string;
  /** Everything under the header, down to the next `## [`, trimmed. */
  body: string;
}

const HEADER = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;

/** Every release section in the file, newest first as written. */
export function parseChangelog(text: string): Release[] {
  const lines = text.split('\n');
  const releases: Release[] = [];
  let current: { version: string; date?: string; lines: string[] } | null = null;

  const close = () => {
    if (!current) return;
    releases.push({
      version: current.version,
      ...(current.date === undefined ? {} : { date: current.date }),
      body: current.lines.join('\n').trim(),
    });
    current = null;
  };

  for (const line of lines) {
    // The link-reference block at the very end (`[1.0.0]: https://…`) is not release content.
    if (/^\[[^\]]+\]: /.test(line)) {
      close();
      continue;
    }
    const match = HEADER.exec(line);
    if (match) {
      close();
      current = { version: match[1], ...(match[2] === undefined ? {} : { date: match[2] }), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  close();
  return releases;
}

export function findRelease(text: string, version: string): Release | undefined {
  const wanted = version.replace(/^v/, '').toLowerCase();
  return parseChangelog(text).find((r) => r.version.toLowerCase() === wanted);
}

/** The Markdown to publish. Headings are demoted one level: a release page already has its own title. */
export function releaseNotes(release: Release): string {
  const body = release.body.replace(/^### /gm, '## ').replace(/^#### /gm, '### ');
  const heading = release.version === 'Unreleased' ? 'Unreleased' : `${release.version}${release.date ? ` — ${release.date}` : ''}`;
  return `# ${heading}\n\n${body}\n`;
}

export function main(argv: readonly string[], read: () => string = () => readFileSync('CHANGELOG.md', 'utf-8')): { code: number; out: string } {
  const version = argv[0] ?? 'Unreleased';
  const release = findRelease(read(), version);
  if (!release) return { code: 1, out: `No section for "${version}" in CHANGELOG.md.\n` };
  if (release.body === '') return { code: 1, out: `The "${version}" section of CHANGELOG.md is empty.\n` };
  return { code: 0, out: releaseNotes(release) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}
