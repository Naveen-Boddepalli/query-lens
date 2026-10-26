import { describe, expect, it } from 'vitest';
import { CHALLENGES } from '../challenges.tsx';
import { CHALLENGE_GROUPS, CHALLENGE_ORDER } from '../groups.ts';
import { SCRIPT_CHALLENGES } from '../scriptChallenges.tsx';
import { SETTINGS_CHALLENGES } from '../settingsChallenges.tsx';

const ids = (list: readonly { id: string }[]) => list.map((c) => c.id);
const group = (id: string) => CHALLENGE_GROUPS.find((g) => g.id === id)!;

describe('the challenge index', () => {
  it('lists the groups in the order a learner meets the subjects', () => {
    expect(CHALLENGE_GROUPS.map((g) => g.id)).toEqual(['queries', 'transactions', 'storage']);
    for (const g of CHALLENGE_GROUPS) expect(g.entries.length, g.id).toBeGreaterThan(0);
  });

  it('holds every challenge of every kind exactly once', () => {
    const listed = CHALLENGE_GROUPS.flatMap((g) => ids(g.entries));
    const all = [...ids(CHALLENGES), ...ids(SCRIPT_CHALLENGES), ...ids(SETTINGS_CHALLENGES)];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...all].sort());
  });

  it('puts queries together, schedules and scripts with the transaction settings, and the other tools last', () => {
    expect(ids(group('queries').entries)).toEqual(ids(CHALLENGES));
    expect(ids(group('transactions').entries)).toEqual([
      ...ids(SCRIPT_CHALLENGES),
      ...ids(SETTINGS_CHALLENGES.filter((c) => c.group === 'transactions')),
    ]);
    expect(ids(group('storage').entries)).toEqual(ids(SETTINGS_CHALLENGES.filter((c) => c.group === 'storage')));
  });

  it('has a settings challenge in each group it names, and none that names neither', () => {
    for (const c of SETTINGS_CHALLENGES) expect(['storage', 'transactions'], c.id).toContain(c.group);
    expect(SETTINGS_CHALLENGES.some((c) => c.group === 'transactions')).toBe(true);
  });

  it('counts "n of m" and "next" over the same order as the index', () => {
    expect(ids(CHALLENGE_ORDER)).toEqual(CHALLENGE_GROUPS.flatMap((g) => ids(g.entries)));
    expect(CHALLENGE_ORDER.every((c) => c.title.length > 0)).toBe(true);
  });
});
