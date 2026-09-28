#!/usr/bin/env -S node --experimental-strip-types
/**
 * Regenerate `public/llms.txt` (plan.md §25.4 H4) — a machine-readable index of the docs, in the format
 * https://llmstxt.org proposes, so an assistant reading this site's URL first gets a short map of what is here
 * instead of having to crawl and guess. Every entry comes straight from `src/docsNav.ts` and each page's own
 * frontmatter `title`/`description` — nothing here is hand-duplicated, so the file cannot drift from the docs the
 * way a hand-written summary would.
 *
 *   pnpm llms-txt
 *
 * Committed, like `public/og.png` (`pnpm og`): re-run this whenever a docs page is added, renamed, or gets a new
 * description, and commit the result. `build-llms-txt.test.ts` calls the same `buildLlmsTxt` this script does and
 * fails if the committed file has drifted from it — the automated half of the discipline `og.png`'s own doc
 * comment can only ask a person to remember.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_NAV } from '../src/docsNav.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The same fallback chain `vite.config.ts`'s SITE_URL uses, for the same reason: an absolute URL is the only kind
// a fetcher reading this file in isolation can resolve. Kept as its own copy rather than a shared import — this
// script runs stand-alone, outside the Vite build, and the two are simple enough that duplicating three lines
// beats adding a module both must import identically.
function siteUrl(): string {
  return (
    process.env.VITE_SITE_URL ??
    process.env.CF_PAGES_URL ??
    'https://query-lens.1234naveenboddepalli.workers.dev'
  ).replace(/\/$/, '');
}

/** `/docs/reference/limits` → `src/pages/DocsContent/reference/limits.mdx`; `/docs` itself → `index.mdx`. */
function mdxPathFor(to: string): string {
  const rest = to.replace(/^\/docs\/?/, '');
  return join(ROOT, 'src/pages/DocsContent', rest === '' ? 'index.mdx' : `${rest}.mdx`);
}

/** Pulls `title`/`description` out of a page's frontmatter block — the same two fields every one of these pages declares (`<DocMeta>` reads them too). */
function frontmatterOf(path: string): { title: string; description: string } {
  const source = readFileSync(path, 'utf8');
  const block = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  const field = (name: string): string => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(block);
    if (!match) throw new Error(`${path} has no \`${name}\` in its frontmatter`);
    return match[1].trim();
  };
  return { title: field('title'), description: field('description') };
}

/** The whole file's content, freshly derived from `DOCS_NAV` and every page's own frontmatter. */
export function buildLlmsTxt(): string {
  const url = siteUrl();
  const sections = DOCS_NAV.map((group) => {
    const lines = group.items.map((item) => {
      const { description } = frontmatterOf(mdxPathFor(item.to));
      return `- [${item.label}](${url}${item.to}): ${description}`;
    });
    return `## ${group.title}\n\n${lines.join('\n')}`;
  }).join('\n\n');

  return `# QueryLens

> An in-browser toy database engine that animates a SQL query through parser, planner, optimizer, execution,
> buffer pool and B+Tree index, one step at a time — a real (if deliberately simplified) engine, not a diagram of
> one.

QueryLens's own claims are checked against real SQLite by a fuzzer on every build (see *How we know the answers
are right*, below), and the engine's simplifications from a production database are stated wherever they matter,
never left implicit. The interactive application itself is at ${url}/playground; the source is at
https://github.com/Naveen-Boddepalli/query-lens.

${sections}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = buildLlmsTxt();
  writeFileSync(join(ROOT, 'public/llms.txt'), output);
  console.log(`Wrote public/llms.txt (${String(output.length)} bytes, ${String(DOCS_NAV.flatMap((g) => g.items).length)} pages).`);
}
