import { runRaft } from '../engine/raft.ts';
import type { RaftResult, RaftScript } from '../engine/raft.ts';
import { RAFT_LINK_LIMITS } from './raftLinks.ts';
import type { RaftSettings } from './raftLinks.ts';

/** plan.md §27.5 X3: the tool's settings as the Raft model's script, and the one call the page and challenge make. */

export function raftScriptOf(s: RaftSettings): RaftScript {
  return {
    servers: s.servers,
    seed: s.seed,
    dropRate: s.drop / 100,
    partitions: s.side === '' ? [] : [{ from: s.partitionFrom, to: s.partitionTo, side: [...s.side].map(Number) }],
    crashes: s.crash === 0 ? [] : [{ server: s.crash, from: s.crashFrom, to: s.crashTo }],
    commands: Array.from({ length: s.commands }, (_, i) => ({ at: 30 + i * 5, command: `x=${String(i + 1)}` })),
    horizon: RAFT_LINK_LIMITS.horizon,
    noOp: s.noOp,
  };
}

export function raftRun(s: RaftSettings): RaftResult {
  return runRaft(raftScriptOf(s));
}
