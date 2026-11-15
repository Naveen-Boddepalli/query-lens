import { runTwoPhaseCommit } from '../engine/twoPhaseCommit.ts';
import type { TpcResult, TpcScript } from '../engine/twoPhaseCommit.ts';
import type { TpcSettings } from './tpcLinks.ts';

/** plan.md §27.5 X2: the tool's settings as the protocol model's script, and the one call the page and challenge make. */

export function scriptOf(s: TpcSettings): TpcScript {
  const n = s.votes.length;
  return {
    votes: [...s.votes].map((c) => (c === 'n' ? 'no' : 'yes')),
    ...(s.coordinatorCrash === 'none' ? {} : { coordinatorCrash: { at: s.coordinatorCrash, recoverAfter: s.coordinatorRecover === 0 ? null : s.coordinatorRecover } }),
    ...(s.participantCrash === 'none'
      ? {}
      : { participantCrash: { participant: Math.min(n, s.crashedParticipant), at: s.participantCrash, recoverAfter: s.participantRecover === 0 ? null : s.participantRecover } }),
    ...(s.lost === 'none' ? {} : { lost: { kind: s.lost, participant: Math.min(n, s.lostParticipant) } }),
  };
}

export function tpcRun(s: TpcSettings): TpcResult {
  return runTwoPhaseCommit(scriptOf(s));
}
