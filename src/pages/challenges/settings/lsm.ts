/** The LSM tree challenges, run on the tool's own planner. */

import { demoWrites as lsmWrites, planLsm } from '../../../ui/lsm.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { fixed, num, SEED, str } from './shared.ts';
import type { Checkers, Values, Verdict } from './shared.ts';

function lsmVerdict(
  v: Values,
  test: (p: ReturnType<typeof planLsm>, writes: number) => boolean,
): Verdict {
  const strategy = str(v, 'strategy') === 'tiered' ? 'tiered' : 'leveled';
  // The challenges expose only the dials that matter; the rest are the tool's own defaults.
  const s = {
    n: num(v, 'n'),
    mem: num(v, 'mem'),
    trigger: num(v, 'trigger'),
    base: 8,
    mult: 2,
    bits: v.bits === undefined ? 8 : num(v, 'bits'),
  };
  const p = planLsm(lsmWrites(s.n, SEED), {
    compactionStrategy: strategy,
    memtableCapacity: s.mem,
    l0CompactionTrigger: s.trigger,
    baseLevelCapacity: s.base,
    levelSizeMultiplier: s.mult,
    bitsPerKey: s.bits,
  });
  return {
    passed: test(p, s.n),
    facts: [
      { label: 'writes', value: String(s.n) },
      { label: 'write amplification', value: fixed(p.writeAmplification) },
      { label: 'read amplification, measured', value: fixed(p.readAmplificationAverage) },
      { label: 'read amplification, worst case', value: String(p.readAmplificationWorstCase) },
      { label: 'space amplification', value: fixed(p.spaceAmplification) },
    ],
    toolHref: storageHref({ tool: 'lsm', ...s, strategy, seed: SEED }),
  };
}

export const CHECKERS: Checkers = {
  'cheap-writes-cheap-reads': (v) => lsmVerdict(v, (p, n) => n >= 40 && p.writeAmplification <= 2.5 && p.readAmplificationAverage <= 0.6),

  'write-amp-below-one': (v) => lsmVerdict(v, (p) => p.writeAmplification < 1),
};
