/**
 * plan.md §27.5 X3: `/tools/raft`'s settings, its named scenarios and how its link reads — kept apart from the Raft model,
 * so a lesson that only links to the tool carries none of it.
 */

export interface RaftSettings {
  servers: 3 | 5;
  seed: number;
  /** Percent of messages lost: 0, 5, 15 or 30. */
  drop: number;
  /** The servers cut off from the rest (digits, e.g. `12`), or empty for no partition. */
  side: string;
  partitionFrom: number;
  partitionTo: number;
  /** The server that crashes, or 0 for none. */
  crash: number;
  crashFrom: number;
  crashTo: number;
  /** How many commands the client sends, one every five ticks from tick 30. */
  commands: number;
  noOp: boolean;
}

export const DROP_RATES = [0, 5, 15, 30] as const;
export const RAFT_LINK_LIMITS = { maxSeed: 999_999, maxTick: 180, maxCommands: 12, horizon: 150 } as const;

const CALM: RaftSettings = { servers: 5, seed: 1, drop: 0, side: '', partitionFrom: 40, partitionTo: 90, crash: 0, crashFrom: 50, crashTo: 90, commands: 5, noOp: true };

export const RAFT_SCENARIOS: readonly { id: string; label: string; settings: RaftSettings }[] = [
  { id: 'calm', label: 'Elect, then replicate', settings: CALM },
  { id: 'leader-crash', label: 'The leader crashes', settings: { ...CALM, crash: 2 } },
  { id: 'minority-leader', label: 'The leader is cut off', settings: { ...CALM, side: '12', commands: 8 } },
  { id: 'lossy', label: 'A lossy network', settings: { ...CALM, drop: 30 } },
  { id: 'three', label: 'Three servers', settings: { ...CALM, servers: 3 } },
];

export const RAFT_DEFAULTS = CALM;

export function raftHref(s: RaftSettings): string {
  const p = new URLSearchParams();
  p.set('n', String(s.servers));
  p.set('seed', String(s.seed));
  if (s.drop !== 0) p.set('drop', String(s.drop));
  if (s.side !== '') {
    p.set('side', s.side);
    p.set('pf', String(s.partitionFrom));
    p.set('pt', String(s.partitionTo));
  }
  if (s.crash !== 0) {
    p.set('crash', String(s.crash));
    p.set('cf', String(s.crashFrom));
    p.set('ct', String(s.crashTo));
  }
  p.set('cmd', String(s.commands));
  if (!s.noOp) p.set('noop', '0');
  return `/tools/raft?${p.toString()}`;
}

const clampInt = (raw: string | null, lo: number, hi: number, fallback: number): number => {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

/** The settings a link names, each checked; the rest at the calm scenario's. */
export function readRaftSettings(search: string): RaftSettings {
  const p = new URLSearchParams(search);
  const d = RAFT_DEFAULTS;
  const L = RAFT_LINK_LIMITS;
  const servers: 3 | 5 = p.get('n') === '3' ? 3 : 5;
  const rawSide = p.get('side') ?? '';
  const sideDigits = [...new Set([...rawSide].filter((c) => /[1-9]/.test(c) && Number(c) <= servers))].sort().join('');
  const side = sideDigits.length > 0 && sideDigits.length < servers ? sideDigits : '';
  const drop = Number(p.get('drop') ?? 0);
  const partitionFrom = clampInt(p.get('pf'), 0, L.maxTick, d.partitionFrom);
  const crashFrom = clampInt(p.get('cf'), 0, L.maxTick, d.crashFrom);
  return {
    servers,
    seed: clampInt(p.get('seed'), 0, L.maxSeed, d.seed),
    drop: (DROP_RATES as readonly number[]).includes(drop) ? drop : 0,
    side,
    partitionFrom,
    partitionTo: Math.max(partitionFrom + 1, clampInt(p.get('pt'), 1, L.maxTick, d.partitionTo)),
    crash: clampInt(p.get('crash'), 0, servers, 0),
    crashFrom,
    crashTo: Math.max(crashFrom + 1, clampInt(p.get('ct'), 1, L.maxTick, d.crashTo)),
    commands: clampInt(p.get('cmd'), 0, L.maxCommands, d.commands),
    noOp: p.get('noop') !== '0',
  };
}
