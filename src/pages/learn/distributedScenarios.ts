import { partitionHref } from '../../ui/partitionLinks.ts';
import type { PartitionSettings } from '../../ui/partitionLinks.ts';

/**
 * The tool settings the distributed-databases lessons link to (plan.md §27.5 X1–X4), named, so a step's link and the
 * test that checks the numbers it quotes read the same settings. `__tests__/distributedLessons.test.ts` runs each.
 */

export interface PartitionScenario extends PartitionSettings {
  tool: 'partitioning';
}

export type DistributedScenario = PartitionScenario;

const P = { tool: 'partitioning', key: 'id', nodes: 4, leaving: 2 } as const;

export const DISTRIBUTED_SCENARIOS = {
  hashGrows: { ...P, scheme: 'hash', virtualNodes: 1, change: 'add' },
  rangeGrows: { ...P, scheme: 'range', virtualNodes: 1, change: 'add' },
  ringOnePoint: { ...P, scheme: 'consistent', virtualNodes: 1, change: 'add' },
  ringManyPoints: { ...P, scheme: 'consistent', virtualNodes: 64, change: 'add' },
} as const satisfies Record<string, DistributedScenario>;

export type DistributedScenarioName = keyof typeof DISTRIBUTED_SCENARIOS;

export function distributedHref(scenario: DistributedScenario): string {
  return partitionHref(scenario);
}
