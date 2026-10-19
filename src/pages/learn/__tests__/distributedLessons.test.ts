import { describe, expect, it } from 'vitest';
import { PARTITION_LIMITS } from '../../../engine/partitioning.ts';
import { PARTITION_LINK_LIMITS } from '../../../ui/partitionLinks.ts';
import { partitionRun, readPartitionSettings } from '../../../ui/partitionPresets.ts';
import { readTpcSettings } from '../../../ui/tpcLinks.ts';
import { tpcRun } from '../../../ui/tpcRun.ts';
import { readRaftSettings } from '../../../ui/raftLinks.ts';
import { raftRun } from '../../../ui/raftRun.ts';
import { electionSafety, leaderCompleteness, logAt, logMatching, stateMachineSafety } from '../../../engine/raft.ts';
import { DISTRIBUTED_SCENARIOS, distributedHref } from '../distributedScenarios.ts';
import { LESSONS } from '../lessons.tsx';

/** The distributed-databases lessons (plan.md §27.5 X1–X4): each step links a scenario, and quotes the tool's numbers. */

const lesson = (id: string) => LESSONS.find((l) => l.id === id)!;

describe('the distributed lessons link the tools as they are', () => {
  it('every step links a scenario, every scenario has a step, and each link reads back as itself', () => {
    const used = new Set(['partitioning', 'two-phase-commit', 'raft'].flatMap((id) => lesson(id).steps.map((s) => s.link!.href)));
    const hrefs = Object.values(DISTRIBUTED_SCENARIOS).map((s) => distributedHref(s));
    expect([...used].sort()).toEqual([...hrefs].sort());
    expect(PARTITION_LINK_LIMITS).toEqual(PARTITION_LIMITS);
    for (const s of Object.values(DISTRIBUTED_SCENARIOS)) {
      const url = new URL(distributedHref(s), 'https://x');
      expect(url.pathname).toBe(`/tools/${s.tool}`);
      const { tool: _tool, ...settings } = s;
      if (s.tool === 'partitioning') expect(readPartitionSettings(url.search)).toEqual(settings);
      else if (s.tool === '2pc') expect(readTpcSettings(url.search)).toEqual(settings);
      else expect(readRaftSettings(url.search)).toEqual(settings);
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

describe('lesson: raft', () => {
  it('calm: server 2 wins term 1 at tick 15, and every server commits through entry 6', () => {
    const r = raftRun(DISTRIBUTED_SCENARIOS.raftCalm);
    expect(r.leaders.map((l) => [l.server, l.term, l.at])).toEqual([[2, 1, 15]]);
    expect(r.final.map((f) => f.commitIndex)).toEqual([6, 6, 6, 6, 6]);
  });

  it('the leader crashes at 50: server 3 wins term 2 at 66, and the command at 50 finds no leader', () => {
    const r = raftRun(DISTRIBUTED_SCENARIOS.raftLeaderCrash);
    expect(r.leaders.map((l) => [l.server, l.term, l.at])).toEqual([[2, 1, 15], [3, 2, 66]]);
    expect(r.unheard.map((u) => [u.at, u.command])).toEqual([[50, 'x=5']]);
  });

  it('cut off 40–90: server 2 takes six more it cannot commit; split votes in terms 2 and 3; server 4 wins term 4 at 84; both drop the six', () => {
    const r = raftRun(DISTRIBUTED_SCENARIOS.raftMinority);
    expect(r.leaders.map((l) => [l.server, l.term, l.at])).toEqual([[2, 1, 15], [4, 4, 84]]);
    expect(logAt(r, 2, 85).filter((e) => e.command.startsWith('x=')).length).toBe(8);
    expect(r.events.filter((e) => e.kind === 'truncate').map((e) => e.server)).toEqual([1, 2]);
    for (const f of r.final) expect(f.log.map((e) => e.command)).toEqual(['no-op', 'x=1', 'x=2', 'no-op']);
  });

  it('a lossy network: server 2 leads term 1, server 3 term 2, and all four properties hold', () => {
    const r = raftRun(DISTRIBUTED_SCENARIOS.raftLossy);
    expect(r.leaders.map((l) => [l.server, l.term])).toEqual([[2, 1], [3, 2]]);
    expect([electionSafety(r), logMatching(r), leaderCompleteness(r), stateMachineSafety(r)]).toEqual([true, true, true, true]);
  });
});
