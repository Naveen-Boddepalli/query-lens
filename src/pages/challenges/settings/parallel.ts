/** The parallel-execution challenge (plan.md §27.5 P1), run by the engine's own morsel model, as the tool runs it. */

import { isDispatch, parallelHref, parallelRun } from '../../../ui/parallelPresets.ts';
import { fixed, num, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** Four workers, the last three times slower, on the totals by status. */
export const SLOW_FOURTH = [1, 1, 1, 3] as const;
export const TARGET_SPEEDUP = 3;

export const CHECKERS: Checkers = {
  'outrun-the-slow-worker': (v) => {
    const raw = str(v, 'dispatch');
    const dispatch = isDispatch(raw) ? raw : 'static';
    const morselPages = num(v, 'morsel');
    const r = parallelRun('grouped', 4, dispatch, morselPages, SLOW_FOURTH);
    return {
      passed: r.speedup >= TARGET_SPEEDUP,
      facts: [
        { label: 'speedup', value: `${fixed(r.speedup)}×` },
        { label: 'ticks', value: r.ticks.toLocaleString('en-US') },
        { label: 'one worker alone', value: r.serialTicks.toLocaleString('en-US') },
        { label: 'morsels stolen', value: String(r.steals) },
        { label: 'pages read remotely', value: String(r.runs.reduce((s, x) => s + x.remotePages, 0)) },
      ],
      toolHref: parallelHref('grouped', 4, dispatch, morselPages, SLOW_FOURTH),
    };
  },
};
