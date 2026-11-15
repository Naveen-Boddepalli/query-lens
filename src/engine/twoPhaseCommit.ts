/**
 * Two-phase commit (plan.md §27.5 X2), with presumed abort: one coordinator, two to five participants, and the failures
 * that make the protocol interesting — a crash at a point in the protocol, a message lost — given as inputs, like a
 * schedule's interleaving (plan.md §27.6 rule 9). Time is ticks; a message sent at tick `t` arrives at `t + 1`, unless
 * it is the one lost or its receiver is down when it arrives. Nothing here is a network: the run is a pure function of
 * its script.
 *
 * The protocol:
 *
 * 1. The coordinator sends PREPARE to every participant. (Under **presumed abort** it writes nothing first: if it
 *    crashes now and forgets the transaction, the answer for it is "abort".)
 * 2. A participant that can commit **forces PREPARED to its log** and votes YES — after which it may not change its
 *    mind, and must wait for the decision however long that takes: it is **in doubt**, holding its locks. One that
 *    cannot commit writes ABORT and votes NO, and is done.
 * 3. With every vote YES, the coordinator **forces COMMIT to its log** — that write is the moment of commit — and sends
 *    COMMIT; each participant forces COMMIT and acknowledges, and once every acknowledgement is in, the coordinator
 *    writes END and may forget. A NO, or a vote missing when its timeout fires, decides ABORT: written lazily, sent to
 *    the participants, never acknowledged — an abort is what anyone who asks about a forgotten transaction is told.
 *
 * Recovery reads the log: a coordinator with COMMIT and no END sends COMMIT again; one with no decision has nothing
 * to resend, and answers any question with ABORT. A participant with PREPARED and no decision is still in doubt and
 * asks the coordinator, every few ticks, until it hears. One that never voted aborts on its own — on recovery, or
 * when no PREPARE has come by tick 12.
 */

export type Vote = 'yes' | 'no';
export type CoordinatorCrash = 'before-prepare' | 'after-prepare' | 'after-votes' | 'after-decision' | 'after-first-commit';
export type ParticipantCrash = 'before-vote' | 'after-vote';
export type MessageKind = 'PREPARE' | 'YES' | 'NO' | 'COMMIT' | 'ABORT' | 'ACK' | 'INQUIRE';

export const COORDINATOR_CRASHES: readonly CoordinatorCrash[] = ['before-prepare', 'after-prepare', 'after-votes', 'after-decision', 'after-first-commit'];
export const PARTICIPANT_CRASHES: readonly ParticipantCrash[] = ['before-vote', 'after-vote'];
export const TPC_LIMITS = { minParticipants: 2, maxParticipants: 5, maxRecovery: 40 } as const;

/** Ticks the coordinator waits for votes, between a participant's questions, and between resending COMMIT. */
export const VOTE_TIMEOUT = 5;
export const INQUIRY_INTERVAL = 4;
export const RETRY_INTERVAL = 4;
/** A participant that has heard no PREPARE by now gives up on the transaction: it never voted, so it may. */
export const UNILATERAL_ABORT = 12;
/** When the run stops, whatever is still undecided. */
export const HORIZON = 60;

export interface TpcScript {
  votes: readonly Vote[];
  /** The coordinator goes down at this point of the protocol, and comes back `recoverAfter` ticks later (never: null). */
  coordinatorCrash?: { at: CoordinatorCrash; recoverAfter: number | null };
  /** Participant `participant` (1-based) goes down at this point, and comes back `recoverAfter` ticks later. */
  participantCrash?: { participant: number; at: ParticipantCrash; recoverAfter: number | null };
  /** The first message of this kind to (or, for a vote, from) this participant is lost. */
  lost?: { kind: 'PREPARE' | 'VOTE' | 'COMMIT'; participant: number };
}

export interface TpcMessage {
  from: number;
  to: number;
  kind: MessageKind;
  sent: number;
  /** When it arrived, or null: lost, or its receiver was down. */
  delivered: number | null;
  why?: 'lost' | 'receiver down';
}

export interface TpcEvent {
  t: number;
  /** 0 is the coordinator; 1… the participants. */
  node: number;
  kind: 'log' | 'crash' | 'recover' | 'timeout' | 'decide';
  text: string;
}

export type ParticipantState = 'committed' | 'aborted' | 'in doubt' | 'never heard';

export interface TpcResult {
  participants: number;
  messages: TpcMessage[];
  events: TpcEvent[];
  logs: { node: number; t: number; record: string }[];
  /** The coordinator's decision, once it has made one, and when. */
  decision: { outcome: 'commit' | 'abort'; t: number } | null;
  /** Each participant's end state, and when it got there (null: never). */
  final: { state: ParticipantState; t: number | null }[];
  /** Each participant's time in doubt: from its YES vote to learning the decision, or to the end of the run. */
  inDoubt: { from: number; to: number; resolved: boolean }[];
  /** Did every participant that decided, decide the same? */
  atomic: boolean;
  ticks: number;
}

interface Pending {
  at: number;
  seq: number;
  run: () => void;
}

export function runTwoPhaseCommit(script: TpcScript): TpcResult {
  const n = Math.max(TPC_LIMITS.minParticipants, Math.min(TPC_LIMITS.maxParticipants, script.votes.length));
  const votes = Array.from({ length: n }, (_, i) => script.votes[i] ?? 'yes');
  const queue: Pending[] = [];
  let seq = 0;
  let now = 0;
  const at = (t: number, run: () => void) => {
    queue.push({ at: t, seq: seq++, run });
  };

  const messages: TpcMessage[] = [];
  const events: TpcEvent[] = [];
  const logs: TpcResult['logs'] = [];
  const up = Array.from({ length: n + 1 }, () => true);
  const log = (node: number, record: string) => {
    logs.push({ node, t: now, record });
    events.push({ t: now, node, kind: 'log', text: record });
  };
  const logged = (node: number, record: string) => logs.some((l) => l.node === node && l.record === record);
  let lostUsed = false;

  // — Coordinator state —
  let decision: TpcResult['decision'] = null;
  const voted = new Map<number, Vote>();
  const acked = new Set<number>();
  let coordinatorCrashed = false;
  let generation = 0; // a crash invalidates the coordinator's pending timers

  // — Participant state —
  const pState: ('init' | 'prepared' | 'committed' | 'aborted')[] = Array.from({ length: n + 1 }, () => 'init');
  const pDone: (number | null)[] = Array.from({ length: n + 1 }, () => null);
  const doubtFrom: (number | null)[] = Array.from({ length: n + 1 }, () => null);
  const pGen = Array.from({ length: n + 1 }, () => 0);
  const participantCrashed = Array.from({ length: n + 1 }, () => false);

  function send(from: number, to: number, kind: MessageKind) {
    const m: TpcMessage = { from, to, kind, sent: now, delivered: null };
    messages.push(m);
    const s = script.lost;
    const participant = from === 0 ? to : from;
    const lostKind = kind === 'YES' || kind === 'NO' ? 'VOTE' : kind;
    if (!lostUsed && s && s.participant === participant && s.kind === lostKind) {
      lostUsed = true;
      m.why = 'lost';
      return;
    }
    at(now + 1, () => {
      if (!up[to]) {
        m.why = 'receiver down';
        return;
      }
      m.delivered = now;
      if (to === 0) coordinatorReceives(from, kind);
      else participantReceives(to, kind);
    });
  }

  // — The coordinator —
  function crashCoordinator(point: CoordinatorCrash): boolean {
    const c = script.coordinatorCrash;
    if (!c || coordinatorCrashed || c.at !== point) return false;
    coordinatorCrashed = true;
    up[0] = false;
    generation += 1;
    events.push({ t: now, node: 0, kind: 'crash', text: 'the coordinator crashes' });
    if (c.recoverAfter !== null) at(now + c.recoverAfter, recoverCoordinator);
    return true;
  }

  function startCommitRound() {
    if (crashCoordinator('before-prepare')) return;
    for (let p = 1; p <= n; p++) send(0, p, 'PREPARE');
    if (crashCoordinator('after-prepare')) return;
    const g = generation;
    at(now + VOTE_TIMEOUT, () => {
      if (g !== generation || !up[0] || decision) return;
      events.push({ t: now, node: 0, kind: 'timeout', text: `not every vote came in within ${String(VOTE_TIMEOUT)} ticks` });
      decide('abort');
    });
  }

  function decide(outcome: 'commit' | 'abort') {
    if (outcome === 'commit') {
      if (crashCoordinator('after-votes')) return;
      log(0, 'COMMIT');
    } else {
      // Presumed abort: an abort needs no forced record, and no acknowledgements.
      log(0, 'ABORT');
    }
    decision = { outcome, t: now };
    events.push({ t: now, node: 0, kind: 'decide', text: outcome === 'commit' ? 'decides COMMIT' : 'decides ABORT' });
    if (outcome === 'commit' && crashCoordinator('after-decision')) return;
    sendDecision();
  }

  function sendDecision() {
    if (!decision) return;
    const kind = decision.outcome === 'commit' ? 'COMMIT' : 'ABORT';
    for (let p = 1; p <= n; p++) {
      // A NO voter has already aborted; it needs no ABORT.
      if (kind === 'ABORT' && voted.get(p) === 'no') continue;
      if (kind === 'COMMIT' && acked.has(p)) continue;
      send(0, p, kind);
      if (kind === 'COMMIT' && crashCoordinator('after-first-commit')) return;
    }
    if (kind === 'COMMIT') {
      const g = generation;
      at(now + RETRY_INTERVAL, () => {
        if (g !== generation || !up[0] || acked.size === n) return;
        sendDecision();
      });
    }
  }

  function coordinatorReceives(from: number, kind: MessageKind) {
    if (kind === 'YES' || kind === 'NO') {
      if (decision || voted.has(from)) return;
      voted.set(from, kind === 'YES' ? 'yes' : 'no');
      if (kind === 'NO') decide('abort');
      else if (voted.size === n && [...voted.values()].every((v) => v === 'yes')) decide('commit');
    } else if (kind === 'ACK') {
      acked.add(from);
      if (acked.size === n && !logged(0, 'END')) log(0, 'END');
    } else if (kind === 'INQUIRE') {
      // What the log says; and with nothing in it, presumed abort.
      send(0, from, decision?.outcome === 'commit' ? 'COMMIT' : 'ABORT');
    }
  }

  function recoverCoordinator() {
    up[0] = true;
    events.push({ t: now, node: 0, kind: 'recover', text: 'the coordinator recovers and reads its log' });
    if (logged(0, 'COMMIT')) {
      decision = { outcome: 'commit', t: logs.find((l) => l.node === 0 && l.record === 'COMMIT')!.t };
      if (!logged(0, 'END')) sendDecision();
    } else if (logged(0, 'ABORT')) {
      decision = { outcome: 'abort', t: logs.find((l) => l.node === 0 && l.record === 'ABORT')!.t };
    }
    // No decision in the log: the transaction is forgotten, and anyone who asks is told ABORT.
  }

  // — The participants —
  function participantDecides(p: number, outcome: 'commit' | 'abort') {
    if (pState[p] === 'committed' || pState[p] === 'aborted') return;
    log(p, outcome === 'commit' ? 'COMMIT' : 'ABORT');
    pState[p] = outcome === 'commit' ? 'committed' : 'aborted';
    pDone[p] = now;
  }

  function crashParticipant(p: number, point: ParticipantCrash): boolean {
    const c = script.participantCrash;
    if (!c || participantCrashed[p] || c.participant !== p || c.at !== point) return false;
    participantCrashed[p] = true;
    up[p] = false;
    pGen[p]! += 1;
    events.push({ t: now, node: p, kind: 'crash', text: `participant ${String(p)} crashes` });
    if (c.recoverAfter !== null) at(now + c.recoverAfter, () => { recoverParticipant(p); });
    return true;
  }

  function askLater(p: number) {
    const g = pGen[p]!;
    at(now + INQUIRY_INTERVAL, () => {
      if (g !== pGen[p] || !up[p] || pState[p] !== 'prepared') return;
      events.push({ t: now, node: p, kind: 'timeout', text: `participant ${String(p)}, in doubt, asks the coordinator` });
      send(p, 0, 'INQUIRE');
      askLater(p);
    });
  }

  function participantReceives(p: number, kind: MessageKind) {
    if (kind === 'PREPARE') {
      if (pState[p] !== 'init') {
        // A repeated PREPARE gets the same answer again; one that has given up says NO.
        if (pState[p] === 'prepared') send(p, 0, 'YES');
        else if (pState[p] === 'aborted') send(p, 0, 'NO');
        return;
      }
      if (crashParticipant(p, 'before-vote')) return;
      if (votes[p - 1] === 'yes') {
        log(p, 'PREPARED');
        pState[p] = 'prepared';
        doubtFrom[p] = now;
        send(p, 0, 'YES');
        if (crashParticipant(p, 'after-vote')) return;
        askLater(p);
      } else {
        participantDecides(p, 'abort');
        send(p, 0, 'NO');
      }
    } else if (kind === 'COMMIT') {
      participantDecides(p, 'commit');
      send(p, 0, 'ACK');
    } else if (kind === 'ABORT') {
      participantDecides(p, 'abort');
    }
  }

  function recoverParticipant(p: number) {
    up[p] = true;
    events.push({ t: now, node: p, kind: 'recover', text: `participant ${String(p)} recovers and reads its log` });
    if (pState[p] === 'prepared') {
      // In doubt still: it voted YES and cannot take that back. Ask now, and again until answered.
      send(p, 0, 'INQUIRE');
      askLater(p);
    } else if (pState[p] === 'init') {
      // It never voted: it may abort on its own, and say so.
      participantDecides(p, 'abort');
      send(p, 0, 'NO');
    }
  }

  // — Run —
  at(0, startCommitRound);
  for (let p = 1; p <= n; p++) {
    at(UNILATERAL_ABORT, () => {
      if (!up[p] || pState[p] !== 'init') return;
      events.push({ t: now, node: p, kind: 'timeout', text: `participant ${String(p)} has heard no PREPARE, and aborts on its own` });
      participantDecides(p, 'abort');
    });
  }
  while (queue.length > 0) {
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = queue.shift()!;
    if (next.at > HORIZON) break;
    now = next.at;
    next.run();
  }
  const ticks = Math.min(HORIZON, Math.max(now, ...messages.map((m) => m.delivered ?? m.sent)));

  const final = Array.from({ length: n }, (_, i) => {
    const p = i + 1;
    const state: ParticipantState =
      pState[p] === 'committed' ? 'committed' : pState[p] === 'aborted' ? 'aborted' : pState[p] === 'prepared' ? 'in doubt' : 'never heard';
    return { state, t: pDone[p] ?? null };
  });
  const inDoubt = Array.from({ length: n }, (_, i) => {
    const p = i + 1;
    const from = doubtFrom[p];
    if (from === null || from === undefined) return { from: 0, to: 0, resolved: true };
    const done = pDone[p];
    return { from, to: done ?? HORIZON, resolved: done !== null && done !== undefined };
  });
  const outcomes = new Set(final.filter((f) => f.state === 'committed' || f.state === 'aborted').map((f) => f.state));
  return { participants: n, messages, events, logs, decision, final, inDoubt, atomic: outcomes.size <= 1, ticks };
}
