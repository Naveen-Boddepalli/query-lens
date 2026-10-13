import type { ReactNode } from 'react';
import { CHALLENGES } from './challenges.tsx';
import { SCRIPT_CHALLENGES } from './scriptChallenges.tsx';
import { SETTINGS_CHALLENGES } from './settingsChallenges.tsx';

/**
 * The three kinds of challenge — a query, a script, a set of settings — are three modules, but the list a player sees
 * is by subject: the settings challenges for the isolation matrix belong with the transactions, not with the storage
 * tools. This is that list, in one place, so the index and the "3 of 41 · next" count on a challenge page cannot
 * disagree about what comes after what.
 */

export interface ChallengeEntry {
  id: string;
  title: string;
  brief: ReactNode;
}

export interface ChallengeGroup {
  id: 'queries' | 'transactions' | 'storage';
  title: string;
  about: string;
  entries: readonly ChallengeEntry[];
}

export const CHALLENGE_GROUPS: readonly ChallengeGroup[] = [
  {
    id: 'queries',
    title: 'Queries',
    about: 'Write a query that makes the engine do — or not do — something specific.',
    entries: CHALLENGES,
  },
  {
    id: 'transactions',
    title: 'Transactions and durability',
    about:
      'Write a schedule of two sessions, a script for the lock table or the write-ahead log, or set an isolation level, and make the engine do it.',
    entries: [...SCRIPT_CHALLENGES, ...SETTINGS_CHALLENGES.filter((c) => c.group === 'transactions')],
  },
  {
    id: 'storage',
    title: 'Storage and execution',
    about:
      'Set the knobs of a sort, a join, a page, an index, a tree, a buffer pool or the planner, and make the numbers say what you claim.',
    entries: SETTINGS_CHALLENGES.filter((c) => c.group === 'storage'),
  },
];

/** Every challenge, in the order the index lists them: what "n of m" and "next" count over. */
export const CHALLENGE_ORDER: readonly { id: string; title: string }[] = CHALLENGE_GROUPS.flatMap((g) =>
  g.entries.map((c) => ({ id: c.id, title: c.title })),
);
