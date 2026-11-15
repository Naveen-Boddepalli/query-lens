import type { PartitionScheme } from '../engine/partitioning.ts';

/**
 * plan.md §27.5 X1: `/tools/partitioning`'s settings and how its link reads — kept apart from the model and the preset's
 * rows, so a lesson or a challenge index that only links to the tool does not carry them.
 */

export type PartitionKey = 'id' | 'account';
export const PARTITION_KEYS: readonly PartitionKey[] = ['id', 'account'];
export const PARTITION_SCHEME_IDS: readonly PartitionScheme[] = ['hash', 'range', 'consistent'];
export const SCHEME_LABELS: Record<PartitionScheme, string> = { hash: 'Hash', range: 'Range', consistent: 'Consistent hashing' };
export type ChangeKind = 'none' | 'add' | 'remove';
/** The tool's own limits — the engine's, repeated here so this module needs nothing of it (a test holds them equal). */
export const PARTITION_LINK_LIMITS = { minNodes: 2, maxNodes: 10, minVirtual: 1, maxVirtual: 64 } as const;

export interface PartitionSettings {
  key: PartitionKey;
  scheme: PartitionScheme;
  nodes: number;
  virtualNodes: number;
  change: ChangeKind;
  /** The node that leaves, for a removal. */
  leaving: number;
}

export const PARTITION_DEFAULTS: PartitionSettings = { key: 'id', scheme: 'consistent', nodes: 4, virtualNodes: 16, change: 'add', leaving: 2 };

export function partitionHref(s: PartitionSettings): string {
  const p = new URLSearchParams();
  p.set('k', s.key);
  p.set('p', s.scheme);
  p.set('n', String(s.nodes));
  p.set('v', String(s.virtualNodes));
  p.set('c', s.change);
  if (s.change === 'remove') p.set('r', String(s.leaving));
  return `/tools/partitioning?${p.toString()}`;
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

/** The settings a link names, each one checked; anything it does not name, or names wrongly, at its default. */
export function readPartitionSettings(search: string): PartitionSettings {
  const p = new URLSearchParams(search);
  const d = PARTITION_DEFAULTS;
  const L = PARTITION_LINK_LIMITS;
  const nodes = clampInt(p.get('n'), L.minNodes, L.maxNodes, d.nodes);
  const change = p.get('c');
  return {
    key: PARTITION_KEYS.includes(p.get('k') as PartitionKey) ? (p.get('k') as PartitionKey) : d.key,
    scheme: PARTITION_SCHEME_IDS.includes(p.get('p') as PartitionScheme) ? (p.get('p') as PartitionScheme) : d.scheme,
    nodes,
    virtualNodes: clampInt(p.get('v'), L.minVirtual, L.maxVirtual, d.virtualNodes),
    change: change === 'none' || change === 'add' || change === 'remove' ? change : d.change,
    leaving: clampInt(p.get('r'), 1, nodes, Math.min(d.leaving, nodes)),
  };
}
