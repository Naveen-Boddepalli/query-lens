/**
 * Raft (plan.md §27.5 X3): leader election and log replication, after Ongaro and Ousterhout's *In Search of an
 * Understandable Consensus Algorithm* (2014), run over a scripted message schedule. How long a message takes, which
 * ones are dropped, when the network splits and which servers crash are all inputs — a seed and a script — so a run is
 * a pure function of them (plan.md §27.6 rule 9), and the property tests can try thousands.
 *
 * What is here is the paper's Figure 2: terms; RequestVote with the up-to-date-log check; AppendEntries with the
 * consistency check, conflict truncation and the leader's commit rule (only entries of its own term are counted, older
 * ones commit beneath them); a no-op appended by every new leader (§8), so that rule never leaves the log waiting; and
 * persistence of `currentTerm`, `votedFor` and the log across a crash, with the commit index rebuilt from the leader.
 *
 * What is not, and the page says so: **no membership changes** (the cluster is three or five servers, fixed), **no
 * snapshots or log compaction**, no client sessions or read leases — a command is handed to whichever server the client
 * last knew as leader, and simply lost if that server is no longer one.
 *
 * Time is ticks. Election timeouts are drawn from the seed (12–23 ticks), a leader sends AppendEntries every 4, and a
 * message takes 1 to 3 ticks. A partition is a window of ticks during which the servers on one side hear nothing from
 * the other.
 */

export type Role = 'follower' | 'candidate' | 'leader';

export interface RaftEntry {
  term: number;
  /** The client's command, or `no-op` for the entry a new leader appends. */
  command: string;
}

export interface RaftScript {
  servers: number;
  seed: number;
  /** The chance, 0 to 0.5, that any one message is lost. */
  dropRate: number;
  /** Windows in which the listed servers (1-based) are cut off from the others. */
  partitions: { from: number; to: number; side: readonly number[] }[];
  /** Windows in which a server is down: it hears nothing, and loses everything but its term, its vote and its log. */
  crashes: { server: number; from: number; to: number }[];
  /** Commands the client sends, and when. */
  commands: { at: number; command: string }[];
  /** When the run stops. */
  horizon: number;
  /**
   * Whether a new leader appends a no-op (§8), default yes. Without it, entries of earlier terms commit only beneath a
   * client's entry of the new term — and the commit rule's one exception (count only your own term's entries) is what
   * keeps Figure 8 from happening.
   */
  noOp?: boolean;
}

export const RAFT_LIMITS = { servers: [3, 5] as const, maxDropRate: 0.5, maxHorizon: 300 } as const;
export const HEARTBEAT = 4;
export const ELECTION_MIN = 12;
export const ELECTION_SPREAD = 12;

export interface RaftMessage {
  from: number;
  to: number;
  kind: 'RequestVote' | 'Vote' | 'AppendEntries' | 'AppendReply';
  term: number;
  sent: number;
  delivered: number | null;
  /** For AppendEntries: how many entries it carried. For a reply: whether it succeeded or the vote was granted. */
  detail: string;
}

export interface RaftEvent {
  t: number;
  server: number;
  kind: 'timeout' | 'elected' | 'step-down' | 'append' | 'commit' | 'truncate' | 'crash' | 'recover' | 'client';
  term: number;
  text: string;
}

export interface RoleSpan {
  server: number;
  from: number;
  to: number;
  role: Role | 'down';
  term: number;
}

/** A server's log and commit index from tick `t` on, until its next snapshot. */
export interface LogSnapshot {
  server: number;
  t: number;
  log: RaftEntry[];
  commitIndex: number;
}

export interface RaftResult {
  servers: number;
  messages: RaftMessage[];
  events: RaftEvent[];
  roles: RoleSpan[];
  snapshots: LogSnapshot[];
  /** Every leader there was: its term, and when it took office. */
  leaders: { server: number; term: number; at: number; log: RaftEntry[] }[];
  /** Every entry any server applied, in index order per server: what its state machine ran. */
  applied: { server: number; index: number; entry: RaftEntry; t: number }[];
  final: { server: number; role: Role | 'down'; term: number; log: RaftEntry[]; commitIndex: number }[];
  /** Commands the client sent that never reached a leader. */
  unheard: { at: number; command: string }[];
  horizon: number;
}

/** A small seeded generator (mulberry32): the same seed, the same run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Server {
  id: number;
  role: Role;
  term: number;
  votedFor: number | null;
  log: RaftEntry[];
  commitIndex: number;
  lastApplied: number;
  votes: Set<number>;
  nextIndex: Map<number, number>;
  matchIndex: Map<number, number>;
  electionDeadline: number;
  /** Bumped by a crash or a role change, so a stale timer does nothing. */
  epoch: number;
  up: boolean;
}

const lastTerm = (log: RaftEntry[]) => log.at(-1)?.term ?? 0;

export function runRaft(script: RaftScript): RaftResult {
  const n = script.servers === 5 ? 5 : 3;
  const majority = Math.floor(n / 2) + 1;
  const rand = mulberry32(script.seed);
  const horizon = Math.max(1, Math.min(RAFT_LIMITS.maxHorizon, Math.floor(script.horizon)));
  const drop = Math.max(0, Math.min(RAFT_LIMITS.maxDropRate, script.dropRate));

  type Pending = { at: number; seq: number; run: () => void };
  const queue: Pending[] = [];
  let seq = 0;
  let now = 0;
  const at = (t: number, run: () => void) => { queue.push({ at: t, seq: seq++, run }); };

  const messages: RaftMessage[] = [];
  const events: RaftEvent[] = [];
  const roles: RoleSpan[] = [];
  const snapshots: LogSnapshot[] = [];
  const leaders: RaftResult['leaders'] = [];
  const applied: RaftResult['applied'] = [];
  const unheard: RaftResult['unheard'] = [];

  const servers: Server[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    role: 'follower',
    term: 0,
    votedFor: null,
    log: [],
    commitIndex: 0,
    lastApplied: 0,
    votes: new Set(),
    nextIndex: new Map(),
    matchIndex: new Map(),
    electionDeadline: 0,
    epoch: 0,
    up: true,
  }));
  const S = (id: number) => servers[id - 1]!;

  // — Bookkeeping for the page and the properties —
  const openSpan = new Map<number, RoleSpan>();
  const markRole = (s: Server) => {
    const role: Role | 'down' = s.up ? s.role : 'down';
    const open = openSpan.get(s.id);
    if (open && open.role === role && open.term === s.term) return;
    if (open) open.to = now;
    const span: RoleSpan = { server: s.id, from: now, to: horizon, role, term: s.term };
    roles.push(span);
    openSpan.set(s.id, span);
  };
  const snap = (s: Server) => {
    snapshots.push({ server: s.id, t: now, log: s.log.map((e) => ({ ...e })), commitIndex: s.commitIndex });
  };
  const event = (s: Server, kind: RaftEvent['kind'], text: string) => { events.push({ t: now, server: s.id, kind, term: s.term, text }); };
  const apply = (s: Server) => {
    while (s.lastApplied < s.commitIndex) {
      s.lastApplied += 1;
      applied.push({ server: s.id, index: s.lastApplied, entry: { ...s.log[s.lastApplied - 1]! }, t: now });
    }
  };

  const partitioned = (a: number, b: number, t: number) =>
    script.partitions.some((p) => t >= p.from && t < p.to && p.side.includes(a) !== p.side.includes(b));

  function send(from: Server, to: number, kind: RaftMessage['kind'], detail: string, deliver: (dest: Server) => void) {
    const m: RaftMessage = { from: from.id, to, kind, term: from.term, sent: now, delivered: null, detail };
    messages.push(m);
    const delay = 1 + Math.floor(rand() * 3);
    const lost = rand() < drop;
    if (lost || partitioned(from.id, to, now)) return;
    at(now + delay, () => {
      const dest = S(to);
      if (!dest.up || partitioned(from.id, to, now)) return;
      m.delivered = now;
      deliver(dest);
    });
  }

  // — Timers —
  function resetElectionTimer(s: Server) {
    s.electionDeadline = now + ELECTION_MIN + Math.floor(rand() * ELECTION_SPREAD);
    const epoch = s.epoch;
    const deadline = s.electionDeadline;
    at(deadline, () => {
      if (!s.up || s.epoch !== epoch || s.electionDeadline !== deadline || s.role === 'leader') return;
      startElection(s);
    });
  }

  function becomeFollower(s: Server, term: number) {
    const was = s.role;
    if (term > s.term) {
      s.term = term;
      s.votedFor = null;
    }
    s.role = 'follower';
    s.epoch += 1;
    if (was === 'leader') event(s, 'step-down', `server ${String(s.id)} steps down: it has seen term ${String(term)}`);
    markRole(s);
    resetElectionTimer(s);
  }

  function startElection(s: Server) {
    s.term += 1;
    s.role = 'candidate';
    s.votedFor = s.id;
    s.votes = new Set([s.id]);
    s.epoch += 1;
    event(s, 'timeout', `server ${String(s.id)} hears no leader, and stands for term ${String(s.term)}`);
    markRole(s);
    resetElectionTimer(s);
    const lastIndex = s.log.length;
    const lt = lastTerm(s.log);
    for (const peer of servers) {
      if (peer.id === s.id) continue;
      send(s, peer.id, 'RequestVote', `last entry ${String(lastIndex)} of term ${String(lt)}`, (dest) => {
        onRequestVote(dest, s.id, s.term, lastIndex, lt);
      });
    }
    if (s.votes.size >= majority) becomeLeader(s);
  }

  function onRequestVote(s: Server, candidate: number, term: number, lastIndex: number, lt: number) {
    if (term > s.term) becomeFollower(s, term);
    const upToDate = lt > lastTerm(s.log) || (lt === lastTerm(s.log) && lastIndex >= s.log.length);
    const grant = term === s.term && (s.votedFor === null || s.votedFor === candidate) && upToDate;
    if (grant) {
      s.votedFor = candidate;
      resetElectionTimer(s);
    }
    send(s, candidate, 'Vote', grant ? 'granted' : 'refused', (dest) => { onVote(dest, s.id, s.term, grant); });
  }

  function onVote(s: Server, voter: number, term: number, granted: boolean) {
    if (term > s.term) {
      becomeFollower(s, term);
      return;
    }
    if (s.role !== 'candidate' || term !== s.term || !granted) return;
    s.votes.add(voter);
    if (s.votes.size >= majority) becomeLeader(s);
  }

  function becomeLeader(s: Server) {
    s.role = 'leader';
    s.epoch += 1;
    for (const peer of servers) {
      s.nextIndex.set(peer.id, s.log.length + 1);
      s.matchIndex.set(peer.id, 0);
    }
    leaders.push({ server: s.id, term: s.term, at: now, log: s.log.map((e) => ({ ...e })) });
    event(s, 'elected', `server ${String(s.id)} wins term ${String(s.term)} with ${String(s.votes.size)} of ${String(n)} votes`);
    markRole(s);
    // §8: a no-op of the new term, so the entries before it can commit beneath it.
    if (script.noOp !== false) {
      s.log.push({ term: s.term, command: 'no-op' });
      s.matchIndex.set(s.id, s.log.length);
      snap(s);
    }
    heartbeat(s);
  }

  function heartbeat(s: Server) {
    if (!s.up || s.role !== 'leader') return;
    for (const peer of servers) if (peer.id !== s.id) replicateTo(s, peer.id);
    const epoch = s.epoch;
    at(now + HEARTBEAT, () => {
      if (s.epoch === epoch) heartbeat(s);
    });
  }

  function replicateTo(s: Server, peer: number) {
    const next = s.nextIndex.get(peer) ?? s.log.length + 1;
    const prevIndex = next - 1;
    const prevTerm = prevIndex === 0 ? 0 : (s.log[prevIndex - 1]?.term ?? 0);
    const entries = s.log.slice(next - 1, next - 1 + 8).map((e) => ({ ...e }));
    const term = s.term;
    const commit = s.commitIndex;
    send(s, peer, 'AppendEntries', `${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'} after ${String(prevIndex)}`, (dest) => {
      onAppendEntries(dest, s.id, term, prevIndex, prevTerm, entries, commit);
    });
  }

  function onAppendEntries(s: Server, leader: number, term: number, prevIndex: number, prevTerm: number, entries: RaftEntry[], leaderCommit: number) {
    if (term < s.term) {
      send(s, leader, 'AppendReply', 'refused: stale term', (dest) => { onAppendReply(dest, s.id, s.term, false, 0); });
      return;
    }
    if (term > s.term || s.role !== 'follower') becomeFollower(s, term);
    else resetElectionTimer(s);
    const matches = prevIndex === 0 || (s.log[prevIndex - 1]?.term ?? -1) === prevTerm;
    if (!matches) {
      send(s, leader, 'AppendReply', `refused: no entry ${String(prevIndex)} of term ${String(prevTerm)}`, (dest) => { onAppendReply(dest, s.id, s.term, false, 0); });
      return;
    }
    let changed = false;
    entries.forEach((entry, k) => {
      const index = prevIndex + 1 + k;
      const mine = s.log[index - 1];
      if (mine && mine.term !== entry.term) {
        event(s, 'truncate', `server ${String(s.id)} drops entries ${String(index)}–${String(s.log.length)}: they conflict with the leader's`);
        s.log.length = index - 1;
      }
      if (!s.log[index - 1]) {
        s.log.push({ ...entry });
        changed = true;
      }
    });
    const lastNew = prevIndex + entries.length;
    if (leaderCommit > s.commitIndex) {
      const commit = Math.min(leaderCommit, lastNew);
      if (commit > s.commitIndex) {
        s.commitIndex = commit;
        changed = true;
        apply(s);
      }
    }
    if (changed) snap(s);
    send(s, leader, 'AppendReply', `ok, has ${String(lastNew)}`, (dest) => { onAppendReply(dest, s.id, s.term, true, lastNew); });
  }

  function onAppendReply(s: Server, from: number, term: number, success: boolean, match: number) {
    if (term > s.term) {
      becomeFollower(s, term);
      return;
    }
    if (s.role !== 'leader' || term !== s.term) return;
    if (!success) {
      s.nextIndex.set(from, Math.max(1, (s.nextIndex.get(from) ?? 1) - 1));
      replicateTo(s, from);
      return;
    }
    s.matchIndex.set(from, Math.max(s.matchIndex.get(from) ?? 0, match));
    s.nextIndex.set(from, (s.matchIndex.get(from) ?? 0) + 1);
    const held = servers.map((p) => (p.id === s.id ? s.log.length : (s.matchIndex.get(p.id) ?? 0)));
    const commit = leaderCommitIndex(s.log, held, s.term, s.commitIndex);
    if (commit > s.commitIndex) {
      event(s, 'commit', `server ${String(s.id)} commits through entry ${String(commit)}: a majority holds it`);
      s.commitIndex = commit;
      apply(s);
      snap(s);
    }
  }

  // — Crashes —
  for (const c of script.crashes) {
    at(c.from, () => {
      const s = S(c.server);
      if (!s.up) return;
      s.up = false;
      s.epoch += 1;
      event(s, 'crash', `server ${String(s.id)} crashes`);
      markRole(s);
    });
    at(c.to, () => {
      const s = S(c.server);
      if (s.up) return;
      s.up = true;
      // Term, vote and log were on disk; the rest starts again.
      s.role = 'follower';
      s.commitIndex = 0;
      s.lastApplied = 0;
      s.epoch += 1;
      event(s, 'recover', `server ${String(s.id)} recovers as a follower of term ${String(s.term)}`);
      markRole(s);
      snap(s);
      resetElectionTimer(s);
    });
  }

  // — The client —
  let knownLeader: number | null = null;
  for (const c of script.commands) {
    at(c.at, () => {
      const current = servers.filter((s) => s.up && s.role === 'leader').sort((a, b) => b.term - a.term);
      const target = knownLeader !== null && S(knownLeader).up && S(knownLeader).role === 'leader' ? S(knownLeader) : current[0];
      if (!target) {
        unheard.push(c);
        return;
      }
      knownLeader = target.id;
      target.log.push({ term: target.term, command: c.command });
      target.matchIndex.set(target.id, target.log.length);
      event(target, 'client', `server ${String(target.id)} takes "${c.command}" as entry ${String(target.log.length)}`);
      snap(target);
    });
  }

  // — Run —
  for (const s of servers) {
    markRole(s);
    snap(s);
    resetElectionTimer(s);
  }
  while (queue.length > 0) {
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = queue.shift()!;
    if (next.at > horizon) break;
    now = next.at;
    next.run();
  }
  now = horizon;
  for (const span of openSpan.values()) span.to = horizon;

  return {
    servers: n,
    messages,
    events,
    roles,
    snapshots,
    leaders,
    applied,
    final: servers.map((s) => ({ server: s.id, role: s.up ? s.role : 'down', term: s.term, log: s.log.map((e) => ({ ...e })), commitIndex: s.commitIndex })),
    unheard,
    horizon,
  };
}

/**
 * The leader's commit rule (§5.3, §5.4.2): the highest index a majority of servers hold (`held`, one count per server,
 * the leader's own log length among them) — but counted only when the entry there is of the leader's own term. An entry
 * of an earlier term is never committed by counting, however many servers hold it: the paper's Figure 8 is a log in
 * which such an entry, held by a majority, is later overwritten. It commits beneath the leader's own entries instead.
 */
export function leaderCommitIndex(log: readonly RaftEntry[], held: readonly number[], term: number, commitIndex: number): number {
  const majority = Math.floor(held.length / 2) + 1;
  for (let index = log.length; index > commitIndex; index--) {
    if (log[index - 1]!.term !== term) break;
    if (held.filter((h) => h >= index).length >= majority) return index;
  }
  return commitIndex;
}

// — Raft's safety properties (the paper's Figure 3), checked on a run —

/** Election Safety: at most one leader per term. */
export function electionSafety(r: RaftResult): boolean {
  const terms = r.leaders.map((l) => l.term);
  return new Set(terms).size === terms.length;
}

/** A server's log as it stood at tick `t`. */
export function logAt(r: RaftResult, server: number, t: number): RaftEntry[] {
  const mine = r.snapshots.filter((s) => s.server === server && s.t <= t);
  return mine.at(-1)?.log ?? [];
}

/**
 * Log Matching: whenever two logs hold an entry with the same index and term, they agree on every entry up to it —
 * checked at every moment any log changed.
 */
export function logMatching(r: RaftResult): boolean {
  const times = [...new Set(r.snapshots.map((s) => s.t))];
  for (const t of times) {
    const logs = Array.from({ length: r.servers }, (_, i) => logAt(r, i + 1, t));
    for (let a = 0; a < logs.length; a++) {
      for (let b = a + 1; b < logs.length; b++) {
        const x = logs[a]!;
        const y = logs[b]!;
        for (let i = Math.min(x.length, y.length); i >= 1; i--) {
          if (x[i - 1]!.term !== y[i - 1]!.term) continue;
          for (let k = 0; k < i; k++) if (x[k]!.term !== y[k]!.term || x[k]!.command !== y[k]!.command) return false;
          break;
        }
      }
    }
  }
  return true;
}

/** Leader Completeness: every entry applied anywhere is in the log of every leader elected after it was applied. */
export function leaderCompleteness(r: RaftResult): boolean {
  for (const a of r.applied) {
    for (const l of r.leaders) {
      if (l.at <= a.t) continue;
      const e = l.log[a.index - 1];
      if (!e || e.term !== a.entry.term || e.command !== a.entry.command) return false;
    }
  }
  return true;
}

/** State Machine Safety: no two servers ever apply different entries at the same index. */
export function stateMachineSafety(r: RaftResult): boolean {
  const byIndex = new Map<number, RaftEntry>();
  for (const a of r.applied) {
    const seen = byIndex.get(a.index);
    if (!seen) byIndex.set(a.index, a.entry);
    else if (seen.term !== a.entry.term || seen.command !== a.entry.command) return false;
  }
  return true;
}
