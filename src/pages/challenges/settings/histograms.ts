/** The histogram challenge (plan.md §27.5 T5), estimated by the engine's own ANALYZE and range estimate, as the tool is. */

import { estimateAt } from '../../../ui/histogramColumns.ts';
import { fixed, num } from './shared.ts';
import type { Checkers } from './shared.ts';

/** The range the challenge asks about, on the clustered column: the gap between the first two bands. */
export const GAP = { low: 500, high: 2000 } as const;
/** How close the estimate must come, and in how few buckets. */
export const TARGET_Q = 1.5;
export const MOST_BUCKETS = 50;

export const CHECKERS: Checkers = {
  'enough-buckets': (v) => {
    const buckets = num(v, 'buckets');
    const e = estimateAt('clustered', GAP.low, GAP.high, buckets);
    return {
      passed: buckets <= MOST_BUCKETS && e.qError <= TARGET_Q,
      facts: [
        { label: 'buckets', value: String(buckets) },
        { label: 'estimated rows', value: e.estimate.toLocaleString('en-US') },
        { label: 'really', value: e.actual.toLocaleString('en-US') },
        { label: 'q-error', value: `${fixed(e.qError)}×` },
      ],
      toolHref: `/tools/histograms?c=clustered&b=${String(buckets)}&lo=${String(GAP.low)}&hi=${String(GAP.high)}`,
    };
  },
};
