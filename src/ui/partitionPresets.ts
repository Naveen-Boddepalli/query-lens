import { DATASETS } from '../engine/datasets.ts';
import { partition } from '../engine/partitioning.ts';
import type { ClusterChange, PartitionResult } from '../engine/partitioning.ts';
import type { PartitionSettings } from './partitionLinks.ts';

/**
 * plan.md §27.5 X1: the one call into the engine that `/tools/partitioning`, its lesson and its challenge all make —
 * the transactions preset's 3,000 rows, by `id` (every key different) or by `account` (40 keys, 75 rows each).
 */

export * from './partitionLinks.ts';

const ROWS = DATASETS.transactions.make().tables.transactions?.rows ?? [];
export const PARTITION_ROWS = ROWS.length;

export function partitionRun(s: PartitionSettings): PartitionResult {
  const change: ClusterChange = s.change === 'add' ? { kind: 'add' } : s.change === 'remove' ? { kind: 'remove', node: s.leaving } : { kind: 'none' };
  return partition(ROWS, s.key, { scheme: s.scheme, nodes: s.nodes, virtualNodes: s.virtualNodes, change });
}
