/** The partitioning challenge (plan.md §27.5 X1), placed by the engine's own model, as the tool places it. */

import { PARTITION_SCHEMES } from '../../../engine/partitioning.ts';
import type { PartitionScheme } from '../../../engine/partitioning.ts';
import { partitionHref, partitionRun, PARTITION_ROWS } from '../../../ui/partitionPresets.ts';
import type { PartitionSettings } from '../../../ui/partitionPresets.ts';
import { fixed, num, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** At most a quarter of the table may move, and the five nodes must end within a fifth of even. */
export const MOST_MOVED = PARTITION_ROWS / 4;
export const MOST_SKEW = 1.2;

export const CHECKERS: Checkers = {
  'grow-without-churn': (v) => {
    const raw = str(v, 'scheme');
    const scheme: PartitionScheme = PARTITION_SCHEMES.includes(raw as PartitionScheme) ? (raw as PartitionScheme) : 'hash';
    const settings: PartitionSettings = { key: 'id', scheme, nodes: 4, virtualNodes: num(v, 'virtual'), change: 'add', leaving: 2 };
    const r = partitionRun(settings);
    const skew = r.after!.skew;
    return {
      passed: r.moved <= MOST_MOVED && skew <= MOST_SKEW,
      facts: [
        { label: 'rows moved', value: `${r.moved.toLocaleString('en-US')} of ${PARTITION_ROWS.toLocaleString('en-US')}` },
        { label: 'skew after', value: fixed(skew) },
        { label: 'rows on the new node', value: r.after!.counts[4]!.toLocaleString('en-US') },
      ],
      toolHref: partitionHref(settings),
    };
  },
};
