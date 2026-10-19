/**
 * plan.md §27.5 X2: `/tools/2pc`'s settings, its named scenarios, and how its link reads — kept apart from the protocol
 * model, so a lesson that only links to the tool carries none of it.
 */

export type CoordinatorCrashPoint = 'none' | 'before-prepare' | 'after-prepare' | 'after-votes' | 'after-decision' | 'after-first-commit';
export type ParticipantCrashPoint = 'none' | 'before-vote' | 'after-vote';
export type LostMessage = 'none' | 'PREPARE' | 'VOTE' | 'COMMIT';

export interface TpcSettings {
  /** One letter per participant: `y` votes yes, `n` no. Two to five. */
  votes: string;
  coordinatorCrash: CoordinatorCrashPoint;
  /** Ticks until the crashed coordinator recovers; 0 for never. */
  coordinatorRecover: number;
  participantCrash: ParticipantCrashPoint;
  crashedParticipant: number;
  participantRecover: number;
  lost: LostMessage;
  lostParticipant: number;
}

const BASE: TpcSettings = {
  votes: 'yyy',
  coordinatorCrash: 'none',
  coordinatorRecover: 10,
  participantCrash: 'none',
  crashedParticipant: 2,
  participantRecover: 10,
  lost: 'none',
  lostParticipant: 1,
};

export const TPC_SCENARIOS: readonly { id: string; label: string; settings: TpcSettings }[] = [
  { id: 'commit', label: 'Everyone votes yes', settings: BASE },
  { id: 'one-no', label: 'One votes no', settings: { ...BASE, votes: 'yny' } },
  { id: 'crash-before-decision', label: 'Coordinator crashes before deciding', settings: { ...BASE, coordinatorCrash: 'after-votes' } },
  { id: 'crash-after-decision', label: 'Coordinator crashes after deciding', settings: { ...BASE, coordinatorCrash: 'after-decision' } },
  { id: 'never-returns', label: 'Coordinator never comes back', settings: { ...BASE, coordinatorCrash: 'after-decision', coordinatorRecover: 0 } },
  { id: 'half-told', label: 'COMMIT reaches one, then a crash', settings: { ...BASE, coordinatorCrash: 'after-first-commit', coordinatorRecover: 8 } },
  { id: 'participant-crash', label: 'A participant crashes after voting', settings: { ...BASE, participantCrash: 'after-vote' } },
  { id: 'lost-vote', label: 'A vote is lost', settings: { ...BASE, lost: 'VOTE', lostParticipant: 3 } },
  { id: 'lost-commit', label: 'A COMMIT is lost', settings: { ...BASE, lost: 'COMMIT', lostParticipant: 1 } },
];

export const TPC_DEFAULTS = TPC_SCENARIOS[3]!.settings;
export const COORDINATOR_POINTS: readonly CoordinatorCrashPoint[] = ['none', 'before-prepare', 'after-prepare', 'after-votes', 'after-decision', 'after-first-commit'];
export const PARTICIPANT_POINTS: readonly ParticipantCrashPoint[] = ['none', 'before-vote', 'after-vote'];
export const LOST_MESSAGES: readonly LostMessage[] = ['none', 'PREPARE', 'VOTE', 'COMMIT'];
export const TPC_LINK_LIMITS = { minParticipants: 2, maxParticipants: 5, maxRecover: 40 } as const;

export function tpcHref(s: TpcSettings): string {
  const p = new URLSearchParams();
  p.set('v', s.votes);
  if (s.coordinatorCrash !== 'none') {
    p.set('c', s.coordinatorCrash);
    p.set('cr', String(s.coordinatorRecover));
  }
  if (s.participantCrash !== 'none') {
    p.set('pc', s.participantCrash);
    p.set('pw', String(s.crashedParticipant));
    p.set('pr', String(s.participantRecover));
  }
  if (s.lost !== 'none') {
    p.set('l', s.lost);
    p.set('lw', String(s.lostParticipant));
  }
  return `/tools/2pc?${p.toString()}`;
}

const clampInt = (raw: string | null, lo: number, hi: number, fallback: number): number => {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

/** The settings a link names, each checked; the rest at the default scenario's. */
export function readTpcSettings(search: string): TpcSettings {
  const p = new URLSearchParams(search);
  const d = TPC_DEFAULTS;
  const L = TPC_LINK_LIMITS;
  const rawVotes = p.get('v');
  const votes = rawVotes && /^[yn]+$/.test(rawVotes) && rawVotes.length >= L.minParticipants && rawVotes.length <= L.maxParticipants ? rawVotes : d.votes;
  const n = votes.length;
  const cc = p.get('c') as CoordinatorCrashPoint | null;
  const pc = p.get('pc') as ParticipantCrashPoint | null;
  const lost = p.get('l') as LostMessage | null;
  const hasLink = p.has('v');
  return {
    votes,
    coordinatorCrash: cc && COORDINATOR_POINTS.includes(cc) ? cc : hasLink ? 'none' : d.coordinatorCrash,
    coordinatorRecover: clampInt(p.get('cr'), 0, L.maxRecover, d.coordinatorRecover),
    participantCrash: pc && PARTICIPANT_POINTS.includes(pc) ? pc : hasLink ? 'none' : d.participantCrash,
    crashedParticipant: clampInt(p.get('pw'), 1, n, Math.min(d.crashedParticipant, n)),
    participantRecover: clampInt(p.get('pr'), 0, L.maxRecover, d.participantRecover),
    lost: lost && LOST_MESSAGES.includes(lost) ? lost : hasLink ? 'none' : d.lost,
    lostParticipant: clampInt(p.get('lw'), 1, n, Math.min(d.lostParticipant, n)),
  };
}
