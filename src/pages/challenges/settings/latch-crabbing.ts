/** The latch-crabbing challenge, run on the scripted workload the tool uses. */

import { DEMO_INITIAL_KEYS, demoScripts, planLatchCrabbing } from '../../../ui/latchCrabbing.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num, pct, SEED } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'crabbing-saves-a-fifth': (v) => {
    const [fanout, threads, ops] = [num(v, 'fanout'), num(v, 'threads'), num(v, 'ops')];
    const scripts = demoScripts(threads, ops, SEED);
    const naive = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'naive');
    const crab = planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'crabbing');
    return {
      passed: crab.ticks * 5 <= naive.ticks * 4,
      facts: [
        { label: 'ticks, naive', value: String(naive.ticks) },
        { label: 'ticks, crabbing', value: String(crab.ticks) },
        { label: 'saved', value: pct(1 - crab.ticks / naive.ticks) },
        { label: 'blocked ticks, naive → crabbing', value: `${String(naive.totalBlockedTicks)} → ${String(crab.totalBlockedTicks)}` },
      ],
      toolHref: storageHref({ tool: 'latch-crabbing', fanout, threads, ops, seed: SEED }),
    };
  },
};
