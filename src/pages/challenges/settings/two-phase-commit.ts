/** The two-phase commit challenge (plan.md §27.5 X2), run by the engine's own protocol model, as the tool runs it. */

import { COORDINATOR_POINTS, TPC_SCENARIOS, tpcHref } from '../../../ui/tpcLinks.ts';
import type { CoordinatorCrashPoint, TpcSettings } from '../../../ui/tpcLinks.ts';
import { tpcRun } from '../../../ui/tpcRun.ts';
import { num, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** How long the participants must wait, at the least. */
export const LEAST_DOUBT = 10;

export const CHECKERS: Checkers = {
  'commit-after-the-wait': (v) => {
    const raw = str(v, 'crash');
    const crash: CoordinatorCrashPoint = COORDINATOR_POINTS.includes(raw as CoordinatorCrashPoint) ? (raw as CoordinatorCrashPoint) : 'none';
    const settings: TpcSettings = { ...TPC_SCENARIOS[0]!.settings, coordinatorCrash: crash, coordinatorRecover: num(v, 'recover') };
    const r = tpcRun(settings);
    const longest = Math.max(0, ...r.inDoubt.map((d) => d.to - d.from));
    const allCommitted = r.final.every((f) => f.state === 'committed');
    return {
      passed: allCommitted && longest >= LEAST_DOUBT,
      facts: [
        { label: 'outcome', value: r.final.map((f, i) => `P${String(i + 1)} ${f.state}`).join(', ') },
        { label: 'longest in doubt', value: `${String(longest)} ticks` },
        { label: 'coordinator’s log', value: r.logs.filter((l) => l.node === 0).map((l) => l.record).join(', ') || '(empty)' },
      ],
      toolHref: tpcHref(settings),
    };
  },
};
