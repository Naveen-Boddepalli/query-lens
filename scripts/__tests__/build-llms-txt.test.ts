import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLlmsTxt, ROOT } from '../build-llms-txt.ts';

/**
 * `public/llms.txt` is generated (`pnpm llms-txt`), not hand-edited — a docs page renamed or given a new
 * description without re-running the script would otherwise drift silently, the exact failure mode §19.3 already
 * calls out for `public/og.png`. This regenerates it in memory and fails if the committed file disagrees, so that
 * drift is a red build instead of a stale file nobody notices.
 */
describe('public/llms.txt is up to date with the docs', () => {
  it('matches what buildLlmsTxt derives from src/docsNav.ts right now', () => {
    const committed = readFileSync(join(ROOT, 'public/llms.txt'), 'utf8');
    expect(committed, 'run `pnpm llms-txt` and commit the result').toBe(buildLlmsTxt());
  });
});
