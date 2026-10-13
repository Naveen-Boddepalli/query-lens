/** The hash index challenge, run on the extendible and linear hashing driver. */

import { demoWrites as hashWrites, planHashIndex } from '../../../ui/hashIndex.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num, SEED, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** The splits a linear-hashing run made of a bucket other than the one that had just overflowed. */
function splitsOfAnotherBucket(events: readonly { kind: string; bucketsChanged: number[] }[]): number {
  const steps = events.filter((e) => e.kind === 'overflow' || e.kind === 'split');
  let other = 0;
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const [a, b] = [steps[i]!, steps[i + 1]!];
    if (a.kind === 'overflow' && b.kind === 'split' && a.bucketsChanged[0] !== b.bucketsChanged[0]) other += 1;
  }
  return other;
}

export const CHECKERS: Checkers = {
  'split-the-other-bucket': (v) => {
    const strategy = str(v, 'strategy') === 'linear' ? 'linear' : 'extendible';
    const [n, cap, init] = [num(v, 'n'), num(v, 'cap'), num(v, 'init')];
    const p = planHashIndex(hashWrites(n, SEED), { strategy, bucketCapacity: cap, initialBuckets: init });
    const other = splitsOfAnotherBucket(p.events);
    const count = (kind: string) => p.events.filter((e) => e.kind === kind).length;
    return {
      passed: other >= 3,
      facts: [
        { label: 'inserts that overflowed a bucket', value: String(count('overflow')) },
        { label: 'splits', value: String(count('split')) },
        { label: 'splits of another bucket', value: String(other) },
        { label: 'buckets', value: String(p.bucketCount) },
        { label: 'longest chain', value: String(p.maxChainLength) },
      ],
      toolHref: storageHref({ tool: 'hash-index', n, strategy, cap, init, seed: SEED }),
    };
  },
};
