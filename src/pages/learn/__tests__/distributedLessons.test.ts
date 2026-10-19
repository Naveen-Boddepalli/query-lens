import { describe, expect, it } from 'vitest';
import { PARTITION_LIMITS } from '../../../engine/partitioning.ts';
import { PARTITION_LINK_LIMITS } from '../../../ui/partitionLinks.ts';
import { partitionRun, readPartitionSettings } from '../../../ui/partitionPresets.ts';
import { readTpcSettings } from '../../../ui/tpcLinks.ts';
import { tpcRun } from '../../../ui/tpcRun.ts';
import { DISTRIBUTED_SCENARIOS, distributedHref } from '../distributedScenarios.ts';
import { LESSONS } from '../lessons.tsx';

/** The distributed-databases lessons (plan.md §27.5 X1–X4): each step links a scenario, and quotes the tool's numbers. */

const lesson = (id: string) => LESSONS.find((l) => l.id === id)!;

describe('the distributed lessons link the tools as they are', () => {
  it('every step links a scenario, every scenario has a step, and each link reads back as itself', () => {
    const used = new Set(['partitioning', 'two-phase-commit'].flatMap((id) => lesson(id).steps.map((s) => s.link!.href)));
    const hrefs = Object.values(DISTRIBUTED_SCENARIOS).map((s) => distributedHref(s));
    expect([...used].sort()).toEqual([...hrefs].sort());
    expect(PARTITION_LINK_LIMITS).toEqual(PARTITION_LIMITS);
    for (const s of Object.values(DISTRIBUTED_SCENARIOS)) {
      const url = new URL(distributedHref(s), 'https://x');
      expect(url.pathname).toBe(`/tools/${s.tool}`);
      const { tool: _tool, ...settings } = s;
      if (s.tool === 'partitioning') expect(readPartitionSettings(url.search)).toEqual(settings);
      else expect(readTpcSettings(url.search)).toEqual(settings);
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

describe('lesson: two-phase commit', () => {
  it('a clean commit: COMMIT logged at tick 2, every participant told at 3', () => {
    const r = tpcRun(DISTRIBUTED_SCENARIOS.tpcCommit);
    expect([r.decision?.outcome, r.decision?.t, r.final.map((f) => `${f.state}@${String(f.t)}`).join(',')]).toEqual(['commit', 2, 'committed@3,committed@3,committed@3']);
  });

  it('one no: the voter aborts at once, the rest are told ABORT, and nobody acknowledges', () => {
    const r = tpcRun(DISTRIBUTED_SCENARIOS.tpcOneNo);
    expect(r.final.every((f) => f.state === 'aborted')).toBe(true);
    expect(r.messages.some((m) => m.kind === 'ACK')).toBe(false);
  });

  it('a crash after COMMIT is logged: 12 ticks in doubt, everyone commits at 13', () => {
    const r = tpcRun(DISTRIBUTED_SCENARIOS.tpcAfterDecision);
    expect([r.inDoubt.map((d) => d.to - d.from).join(','), r.final.map((f) => `${f.state}@${String(f.t)}`).join(',')]).toEqual(['12,12,12', 'committed@13,committed@13,committed@13']);
  });

  it('a crash before it: presumed abort, everyone aborts at 15', () => {
    const r = tpcRun(DISTRIBUTED_SCENARIOS.tpcBeforeDecision);
    expect(r.final.map((f) => `${f.state}@${String(f.t)}`).join(',')).toBe('aborted@15,aborted@15,aborted@15');
  });

  it('no recovery: every participant still in doubt at the end', () => {
    const r = tpcRun(DISTRIBUTED_SCENARIOS.tpcNeverReturns);
    expect(r.final.map((f) => f.state)).toEqual(['in doubt', 'in doubt', 'in doubt']);
  });
});
