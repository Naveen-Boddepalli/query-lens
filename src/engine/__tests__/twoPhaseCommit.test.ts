/** plan.md §27.5 X2 — two-phase commit with presumed abort: atomic under any script, and blocking exactly where it must. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COORDINATOR_CRASHES, HORIZON, PARTICIPANT_CRASHES, runTwoPhaseCommit } from '../twoPhaseCommit.ts';
import type { TpcScript, Vote } from '../twoPhaseCommit.ts';

const yes = (n: number): Vote[] => Array.from({ length: n }, () => 'yes');

const scriptArb: fc.Arbitrary<TpcScript> = fc.integer({ min: 2, max: 5 }).chain((n) =>
  fc.record(
    {
      votes: fc.array(fc.constantFrom<Vote>('yes', 'yes', 'no'), { minLength: n, maxLength: n }),
      coordinatorCrash: fc.record({ at: fc.constantFrom(...COORDINATOR_CRASHES), recoverAfter: fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }) }),
      participantCrash: fc.record({
        participant: fc.integer({ min: 1, max: n }),
        at: fc.constantFrom(...PARTICIPANT_CRASHES),
        recoverAfter: fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }),
      }),
      lost: fc.record({ kind: fc.constantFrom<'PREPARE' | 'VOTE' | 'COMMIT'>('PREPARE', 'VOTE', 'COMMIT'), participant: fc.integer({ min: 1, max: n }) }),
    },
    { requiredKeys: ['votes'] },
  ),
);

describe('two-phase commit (plan.md §27.5 X2)', () => {
  it('is atomic under any script of votes, crashes and a lost message: no participant commits where another aborts', () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        const r = runTwoPhaseCommit(script);
        expect(r.atomic, JSON.stringify(script)).toBe(true);
        // Commit only if every participant voted yes, and only with COMMIT in the coordinator's log first.
        if (r.final.some((f) => f.state === 'committed')) {
          expect(script.votes.every((v) => v === 'yes')).toBe(true);
          const commitLog = r.logs.find((l) => l.node === 0 && l.record === 'COMMIT');
          expect(commitLog).toBeDefined();
          for (const f of r.final) if (f.state === 'committed') expect(f.t!).toBeGreaterThan(commitLog!.t);
        }
        // A NO voter aborts, and a participant commits only after forcing PREPARED.
        script.votes.forEach((v, i) => {
          if (v === 'no' && r.final[i]!.state !== 'never heard' && r.final[i]!.state !== 'in doubt') expect(r.final[i]!.state).toBe('aborted');
          if (r.final[i]!.state === 'committed') expect(r.logs.some((l) => l.node === i + 1 && l.record === 'PREPARED')).toBe(true);
        });
      }),
      { numRuns: 400, seed: 3 },
    );
  });

  it('decides everyone, the same way, whenever every crashed node comes back', () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        if (script.coordinatorCrash?.recoverAfter === null || script.participantCrash?.recoverAfter === null) return;
        const r = runTwoPhaseCommit(script);
        expect(r.final.every((f) => f.state === 'committed' || f.state === 'aborted'), JSON.stringify(script)).toBe(true);
        expect(r.inDoubt.every((d) => d.resolved)).toBe(true);
      }),
      { numRuns: 400, seed: 4 },
    );
  });

  it('with no failures, commits when every vote is yes and aborts on a single no', () => {
    const all = runTwoPhaseCommit({ votes: yes(3) });
    expect(all.final.map((f) => f.state)).toEqual(['committed', 'committed', 'committed']);
    expect(all.logs.filter((l) => l.node === 0).map((l) => l.record)).toEqual(['COMMIT', 'END']);
    const one = runTwoPhaseCommit({ votes: ['yes', 'no', 'yes'] });
    expect(one.final.map((f) => f.state)).toEqual(['aborted', 'aborted', 'aborted']);
    // Presumed abort: no acknowledgements for an abort.
    expect(one.messages.filter((m) => m.kind === 'ACK')).toEqual([]);
  });

  it('blocks: a coordinator that decides COMMIT and never comes back leaves every participant in doubt to the end', () => {
    const r = runTwoPhaseCommit({ votes: yes(3), coordinatorCrash: { at: 'after-decision', recoverAfter: null } });
    expect(r.decision?.outcome).toBe('commit');
    expect(r.final.map((f) => f.state)).toEqual(['in doubt', 'in doubt', 'in doubt']);
    expect(r.inDoubt.map((d) => [d.from, d.to, d.resolved])).toEqual([[1, HORIZON, false], [1, HORIZON, false], [1, HORIZON, false]]);
  });

  it('presumes abort: a coordinator that crashes before logging the decision forgets, and answers ABORT when asked', () => {
    const r = runTwoPhaseCommit({ votes: yes(3), coordinatorCrash: { at: 'after-votes', recoverAfter: 10 } });
    expect(r.logs.filter((l) => l.node === 0)).toEqual([]);
    expect(r.final.map((f) => f.state)).toEqual(['aborted', 'aborted', 'aborted']);
    expect(r.inDoubt.map((d) => d.to)).toEqual([15, 15, 15]);
  });

  it('recovers the decision from the log: after COMMIT is written, a recovering coordinator sends it again', () => {
    const r = runTwoPhaseCommit({ votes: yes(3), coordinatorCrash: { at: 'after-decision', recoverAfter: 10 } });
    expect(r.final.map((f) => f.state)).toEqual(['committed', 'committed', 'committed']);
    expect(r.inDoubt.map((d) => d.to)).toEqual([13, 13, 13]);
  });

  it('a lost vote times out into an abort; a lost COMMIT is sent again', () => {
    const vote = runTwoPhaseCommit({ votes: yes(3), lost: { kind: 'VOTE', participant: 3 } });
    expect([vote.decision?.outcome, vote.events.some((e) => e.kind === 'timeout' && e.node === 0)]).toEqual(['abort', true]);
    const commit = runTwoPhaseCommit({ votes: yes(3), lost: { kind: 'COMMIT', participant: 1 } });
    expect(commit.final.map((f) => f.state)).toEqual(['committed', 'committed', 'committed']);
    // Sent again by the coordinator's retry, and in answer to the participant's own question.
    expect(commit.messages.filter((m) => m.kind === 'COMMIT' && m.to === 1).length).toBeGreaterThanOrEqual(2);
  });

  it('a participant that never hears PREPARE gives up on its own', () => {
    const r = runTwoPhaseCommit({ votes: yes(2), coordinatorCrash: { at: 'before-prepare', recoverAfter: 5 } });
    expect(r.final.map((f) => f.state)).toEqual(['aborted', 'aborted']);
  });
});
