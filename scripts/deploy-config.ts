#!/usr/bin/env -S node --experimental-strip-types
/**
 * Which files change what the *platform* does, as opposed to what the app does
 * (plan.md §25.4 A4, §25.5 rule 4).
 *
 * The first deploy needed three fixes that no local check could have found — an
 * install-script allowlist in the wrong YAML shape, an SPA rewrite that formed a
 * redirect cycle on the newer Cloudflare engine, and a canonical URL pointing at a
 * domain that never resolved (CHANGELOG 1.0.0, *Fixed*). Every one was config
 * written against an assumption the platform had not been asked to confirm. So a
 * change to any of these files carries one extra obligation: *look at a preview
 * deploy* before relying on it. CI cannot do that for you, but it can notice.
 *
 *   node --experimental-strip-types scripts/deploy-config.ts <changed files…>
 *
 * prints the files that match, one per line, and always exits 0 — it informs, it
 * does not block (the CI job turns the output into a warning annotation).
 */

import { fileURLToPath } from 'node:url';

/** Paths (or prefixes ending in `/`) whose change is only proved on a real deploy. */
export const DEPLOY_CONFIG: readonly { path: string; why: string }[] = [
  { path: 'wrangler.jsonc', why: 'asset routing and SPA fallback are interpreted by the Cloudflare engine, not by anything run locally' },
  { path: 'public/', why: 'headers, redirects and static files are served exactly as the platform reads them' },
  { path: 'index.html', why: 'canonical, og:url and og:image resolve only against the real origin' },
  { path: 'pnpm-workspace.yaml', why: 'the install-script allowlist is read by the build host’s package manager' },
  { path: '.node-version', why: 'the build host picks its Node from this' },
];

export function touchesDeployConfig(files: readonly string[]): { file: string; why: string }[] {
  const hits: { file: string; why: string }[] = [];
  for (const file of files) {
    const rule = DEPLOY_CONFIG.find((c) => (c.path.endsWith('/') ? file.startsWith(c.path) : file === c.path));
    if (rule) hits.push({ file, why: rule.why });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { file, why } of touchesDeployConfig(process.argv.slice(2))) console.log(`${file}\t${why}`);
}
