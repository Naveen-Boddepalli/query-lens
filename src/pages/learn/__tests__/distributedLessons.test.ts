import { describe, expect, it } from 'vitest';
import { PARTITION_LIMITS } from '../../../engine/partitioning.ts';
import { PARTITION_LINK_LIMITS } from '../../../ui/partitionLinks.ts';
import { partitionRun, readPartitionSettings } from '../../../ui/partitionPresets.ts';
import { DISTRIBUTED_SCENARIOS, distributedHref } from '../distributedScenarios.ts';
import { LESSONS } from '../lessons.tsx';

/** The distributed-databases lessons (plan.md §27.5 X1–X4): each step links a scenario, and quotes the tool's numbers. */

const lesson = (id: string) => LESSONS.find((l) => l.id === id)!;

describe('the distributed lessons link the tools as they are', () => {
  it('every step links a scenario, every scenario has a step, and each link reads back as itself', () => {
    const used = new Set(['partitioning'].flatMap((id) => lesson(id).steps.map((s) => s.link!.href)));
    const hrefs = Object.values(DISTRIBUTED_SCENARIOS).map((s) => distributedHref(s));
    expect([...used].sort()).toEqual([...hrefs].sort());
    expect(PARTITION_LINK_LIMITS).toEqual(PARTITION_LIMITS);
    for (const s of Object.values(DISTRIBUTED_SCENARIOS)) {
      const url = new URL(distributedHref(s), 'https://x');
      expect(url.pathname).toBe('/tools/partitioning');
      const { tool: _tool, ...settings } = s;
      expect(readPartitionSettings(url.search)).toEqual(settings);
      expect(s.nodes).toBeGreaterThanOrEqual(PARTITION_LIMITS.minNodes);
    }
  });
});

describe('lesson: partitioning', () => {
  it('hash on four: 723/788/757/732, skew 1.05; a fifth node moves 2,399 against a fair 600', () => {
    const r = partitionRun(DISTRIBUTED_SCENARIOS.hashGrows);
    expect([r.before.counts.join('/'), r.before.skew.toFixed(2), r.moved, r.minimum]).toEqual(['723/788/757/732', '1.05', 2399, 600]);
  });

  it('range: 375 move, the newcomer and its neighbour half-full, and the next 300 ids all on the last node', () => {
    const r = partitionRun(DISTRIBUTED_SCENARIOS.rangeGrows);
    expect([r.moved, r.after!.counts.join('/'), r.inserts.counts.join('/')]).toEqual([375, '375/375/750/750/750', '0/0/0/300']);
  });

  it('one point each: skew 1.96, and the fifth node takes 1,459; sixty-four each: skew 1.07, and 590 move, all to it', () => {
    const one = partitionRun(DISTRIBUTED_SCENARIOS.ringOnePoint);
    expect([one.before.skew.toFixed(2), one.moved]).toEqual(['1.96', 1459]);
    const many = partitionRun(DISTRIBUTED_SCENARIOS.ringManyPoints);
    expect([many.before.skew.toFixed(2), many.moved, many.after!.counts[4]]).toEqual(['1.07', 590, 590]);
  });

  it('by account: 525/975/450/1,050 under hash, skew 1.40', () => {
    const r = partitionRun({ ...DISTRIBUTED_SCENARIOS.hashGrows, key: 'account', change: 'none' });
    expect([r.before.counts.join('/'), r.before.skew.toFixed(2)]).toEqual(['525/975/450/1050', '1.40']);
  });
});
