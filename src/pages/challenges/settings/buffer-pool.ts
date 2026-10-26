/** The buffer pool challenges, run on the same trace the sandbox runs. */

import { DEFAULT_ENGINE_OPTIONS } from '../../../engine/index.ts';
import type { ReplacementPolicyName } from '../../../engine/index.ts';
import { parseReferenceScans, runBufferTrace } from '../../../engine/bufferTrace.ts';
import { sandboxHref } from '../../learn/sandboxScenarios.ts';
import { num, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** The scan the `scan-keeps-the-hot-set` challenge asks about: a hot set, a 21-page scan, the hot set again. */
const HOT_SET_SCAN = '0 1 2 3 0 1 2 3 0 1 2 3 10-30 0 1 2 3 0 1 2 3';

function bufferRun(ref: string, frames: number, policy: string, scanRing = 0) {
  const { refs, scans } = parseReferenceScans(ref);
  const result = runBufferTrace(
    refs,
    { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy: policy as ReplacementPolicyName, readAhead: 0, scanRing },
    scans,
  );
  let hits = 0;
  let misses = 0;
  const victims: number[] = [];
  for (const e of result.events) {
    if (e.stage !== 'buffer') continue;
    if (e.action === 'hit') hits += 1;
    else if (e.action === 'miss') misses += 1;
    else if (e.action === 'evict') victims.push(e.victimPageId);
  }
  return { references: refs.length, hits, misses, victims };
}

export const CHECKERS: Checkers = {
  'bigger-pool-more-misses': (v) => {
    const [ref, frames, policy] = [str(v, 'ref'), num(v, 'frames'), str(v, 'policy')];
    const href = sandboxHref({ tool: 'buffer-pool', ref, frames, policy, ra: 0, sr: 0 });
    const less = bufferRun(ref, frames, policy);
    if (less.references === 0) {
      return { passed: false, facts: [], problem: 'Write at least one page number.', toolHref: href };
    }
    const more = bufferRun(ref, frames + 1, policy);
    return {
      passed: more.misses > less.misses,
      facts: [
        { label: 'references', value: String(less.references) },
        { label: `misses in ${String(frames)} frames`, value: String(less.misses) },
        { label: `in ${String(frames + 1)}`, value: String(more.misses) },
        { label: 'difference', value: `${more.misses >= less.misses ? '+' : ''}${String(more.misses - less.misses)}` },
      ],
      toolHref: href,
    };
  },

  'clock-is-not-lru': (v) => {
    const [ref, frames] = [str(v, 'ref'), num(v, 'frames')];
    const href = sandboxHref({ tool: 'buffer-pool', ref, frames, policy: 'clock', ra: 0, sr: 0 });
    const lru = bufferRun(ref, frames, 'lru');
    if (lru.references === 0) return { passed: false, facts: [], problem: 'Write at least one page number.', toolHref: href };
    const clock = bufferRun(ref, frames, 'clock');
    const differ = JSON.stringify(lru.victims) !== JSON.stringify(clock.victims);
    const at = lru.victims.findIndex((x, i) => x !== clock.victims[i]);
    const list = (xs: number[]) => (xs.length === 0 ? 'none' : xs.join(', '));
    return {
      passed: differ,
      facts: [
        { label: 'references', value: String(lru.references) },
        { label: 'misses, LRU / clock', value: `${String(lru.misses)} / ${String(clock.misses)}` },
        { label: 'first different eviction', value: differ ? `the ${String(Math.max(at, 0) + 1)}th` : 'none' },
      ],
      tables: [
        {
          caption: 'The pages each policy evicted, in order',
          columns: ['Policy', 'Evicted'],
          rows: [
            ['LRU', list(lru.victims)],
            ['Clock sweep', list(clock.victims)],
          ],
        },
      ],
      toolHref: href,
    };
  },

  'scan-keeps-the-hot-set': (v) => {
    const [policy, frames, ring] = [str(v, 'policy'), num(v, 'frames'), num(v, 'ring')];
    const r = bufferRun(HOT_SET_SCAN, frames, policy, ring);
    return {
      passed: r.hits >= 16,
      facts: [
        { label: 'references', value: String(r.references) },
        { label: 'hits', value: String(r.hits) },
        { label: 'misses', value: String(r.misses) },
        { label: 'pages evicted', value: String(r.victims.length) },
      ],
      toolHref: sandboxHref({ tool: 'buffer-pool', ref: HOT_SET_SCAN, frames, policy, ra: 0, sr: ring }),
    };
  },
};
