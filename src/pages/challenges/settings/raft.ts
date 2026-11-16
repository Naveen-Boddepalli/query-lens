/** The Raft challenge (plan.md §27.5 X3), run by the engine's own Raft model, as the tool runs it. */

import { electionSafety, leaderCompleteness, logMatching, stateMachineSafety } from '../../../engine/raft.ts';
import { RAFT_SCENARIOS, raftHref } from '../../../ui/raftLinks.ts';
import type { RaftSettings } from '../../../ui/raftLinks.ts';
import { raftRun } from '../../../ui/raftRun.ts';
import { str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** The windows the challenge offers. */
export const WINDOWS: Record<string, [number, number]> = { early: [10, 25], middle: [40, 90], late: [100, 140] };

export const CHECKERS: Checkers = {
  'lost-in-the-minority': (v) => {
    const side = ['12', '2', '1', '4', '345'].includes(str(v, 'side')) ? str(v, 'side') : '4';
    const [from, to] = WINDOWS[str(v, 'window')] ?? WINDOWS.late!;
    const settings: RaftSettings = { ...RAFT_SCENARIOS[0]!.settings, commands: 8, side, partitionFrom: from, partitionTo: to };
    const r = raftRun(settings);
    const kept = new Set(r.final.flatMap((f) => f.log.map((e) => e.command)));
    const taken = r.events.filter((e) => e.kind === 'client').map((e) => /"(.+)"/.exec(e.text)?.[1] ?? '');
    const lost = taken.filter((c) => !kept.has(c));
    const safe = electionSafety(r) && logMatching(r) && leaderCompleteness(r) && stateMachineSafety(r);
    return {
      passed: lost.length > 0 && safe,
      facts: [
        { label: 'leaders', value: r.leaders.map((l) => `S${String(l.server)} (term ${String(l.term)})`).join(', ') || 'none' },
        { label: 'commands a leader took, then lost', value: lost.length === 0 ? 'none' : lost.join(', ') },
        { label: 'committed entries ever lost', value: safe ? 'none — every safety property holds' : 'a safety property failed' },
      ],
      toolHref: raftHref(settings),
    };
  },
};
