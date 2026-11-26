/** plan.md §27.5 X3 — Raft: the paper's safety properties, asserted over seeded random schedules. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { electionSafety, leaderCommitIndex, leaderCompleteness, logMatching, mulberry32, runRaft, stateMachineSafety } from '../raft.ts';
import type { RaftScript } from '../raft.ts';

const commands = (count: number, start = 30, gap = 6) => Array.from({ length: count }, (_, i) => ({ at: start + i * gap, command: `x=${String(i + 1)}` }));
const BASE: RaftScript = { servers: 5, seed: 1, dropRate: 0, partitions: [], crashes: [], commands: commands(5), horizon: 120 };

const scriptArb: fc.Arbitrary<RaftScript> = fc.constantFrom(3, 5).chain((servers) =>
  fc.record({
    servers: fc.constant(servers),
    seed: fc.integer({ min: 0, max: 1_000_000 }),
    dropRate: fc.constantFrom(0, 0.05, 0.15, 0.3),
    partitions: fc.array(
      fc.record({
        from: fc.integer({ min: 0, max: 120 }),
        to: fc.integer({ min: 0, max: 160 }),
        side: fc.uniqueArray(fc.integer({ min: 1, max: servers }), { minLength: 1, maxLength: servers - 1 }),
      }).map((p) => ({ ...p, to: Math.max(p.from + 1, p.to) })),
      { maxLength: 2 },
    ),
    crashes: fc.array(
      fc.record({ server: fc.integer({ min: 1, max: servers }), from: fc.integer({ min: 0, max: 120 }), to: fc.integer({ min: 0, max: 160 }) }).map((c) => ({
        ...c,
        to: Math.max(c.from + 1, c.to),
      })),
      { maxLength: 2 },
    ),
    commands: fc.integer({ min: 0, max: 12 }).chain((k) => fc.uniqueArray(fc.integer({ min: 5, max: 170 }), { minLength: k, maxLength: k }).map((ats) => ats.sort((a, b) => a - b).map((at, i) => ({ at, command: `c${String(i + 1)}` })))),
    horizon: fc.constant(180),
  }),
);

describe('Raft’s safety properties hold on every schedule (plan.md §27.5 X3)', () => {
  it('Election Safety, Log Matching, Leader Completeness and State Machine Safety, over seeded random schedules', () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        const r = runRaft(script);
        const said = JSON.stringify(script);
        expect(electionSafety(r), `election safety: ${said}`).toBe(true);
        expect(logMatching(r), `log matching: ${said}`).toBe(true);
        expect(leaderCompleteness(r), `leader completeness: ${said}`).toBe(true);
        expect(stateMachineSafety(r), `state machine safety: ${said}`).toBe(true);
      }),
      { numRuns: 400, seed: 11 },
    );
  }, 120_000);

  it('is the same run for the same seed and script', () => {
    expect(runRaft(BASE)).toEqual(runRaft(BASE));
    expect(mulberry32(7)()).toBe(mulberry32(7)());
  });
});

describe('what a run shows (plan.md §27.5 X3)', () => {
  it('calm: one leader, every command committed and applied by every server', () => {
    const r = runRaft(BASE);
    expect(r.leaders.map((l) => [l.server, l.term])).toEqual([[2, 1]]);
    for (const f of r.final) {
      expect(f.log.map((e) => e.command)).toEqual(['no-op', 'x=1', 'x=2', 'x=3', 'x=4', 'x=5']);
      expect(f.commitIndex).toBe(6);
    }
  });

  it('a new leader appends a no-op, and commits only its own term’s entries by counting', () => {
    const r = runRaft(BASE);
    expect(r.final[1]!.log[0]).toEqual({ term: 1, command: 'no-op' });
    for (const e of r.events.filter((x) => x.kind === 'commit')) {
      const leader = r.leaders.find((l) => l.server === e.server && l.term === e.term);
      expect(leader).toBeDefined();
    }
  });

  it('a leader cut off in a minority takes commands it can never commit, and they are dropped when it rejoins', () => {
    const r = runRaft({ ...BASE, partitions: [{ from: 40, to: 90, side: [1, 2] }], commands: commands(8, 30, 5) });
    expect(r.leaders.map((l) => l.server)).toEqual([2, 4]);
    expect(r.events.filter((e) => e.kind === 'truncate').length).toBeGreaterThan(0);
    // The commands the stale leader took during the partition never reached a majority, and are gone from every log.
    const survived = new Set(r.final[0]!.log.map((e) => e.command));
    const lost = r.events.filter((e) => e.kind === 'client' && e.server === 2 && e.t >= 40 && e.t < 90).map((e) => /"(.+)"/.exec(e.text)![1]!);
    expect(lost.length).toBeGreaterThan(0);
    for (const c of lost) expect(survived.has(c)).toBe(false);
    // And none of them was ever applied anywhere.
    for (const c of lost) expect(r.applied.some((a) => a.entry.command === c)).toBe(false);
  });

  it('when the leader crashes, the others elect a new one with every committed entry', () => {
    const r = runRaft({ ...BASE, crashes: [{ server: 2, from: 50, to: 90 }] });
    expect(r.leaders.length).toBe(2);
    const second = r.leaders[1]!;
    const committedBefore = r.applied.filter((a) => a.t < second.at);
    for (const a of committedBefore) expect(second.log[a.index - 1]).toEqual(a.entry);
  });
});

describe('the cases random schedules rarely reach (plan.md §27.5 X3)', () => {
  it('Figure 8: a leader never commits an earlier term’s entry by counting, however many servers hold it', () => {
    // S1 leads term 4 with [T1, T2]; S1, S2 and S3 — a majority of five — hold entry 2, which is of term 2.
    const log = [{ term: 1, command: 'a' }, { term: 2, command: 'b' }];
    expect(leaderCommitIndex(log, [2, 2, 2, 1, 1], 4, 1)).toBe(1);
    // Once an entry of its own term is on a majority, everything beneath it commits with it.
    const later = [...log, { term: 4, command: 'c' }];
    expect(leaderCommitIndex(later, [3, 3, 3, 1, 1], 4, 1)).toBe(3);
    // Not a majority: nothing.
    expect(leaderCommitIndex(later, [3, 3, 1, 1, 1], 4, 1)).toBe(1);
  });

  it('a server that crashes and recovers keeps its vote: a schedule that elects two leaders in one term if it does not', () => {
    // Found by searching random schedules with the vote forgotten on recovery: three servers, a crash, and two
    // leaders for the same term. Kept, so that mistake cannot come back unnoticed.
    const r = runRaft({
      servers: 3,
      seed: 971968,
      dropRate: 0,
      partitions: [{ from: 21, to: 29, side: [1] }],
      crashes: [{ server: 2, from: 67, to: 75 }, { server: 1, from: 69, to: 86 }, { server: 3, from: 50, to: 70 }],
      commands: [11, 24, 43, 61, 65, 67, 109, 154].map((at, i) => ({ at, command: `c${String(i)}` })),
      horizon: 180,
      noOp: false,
    });
    expect(electionSafety(r)).toBe(true);
    expect(stateMachineSafety(r)).toBe(true);
  });
});
