import { beforeEach, describe, expect, it } from 'vitest';
import { SKILLS } from '../generators.ts';
import {
  BOXES,
  BOX_DAYS,
  clearDeck,
  dueSkills,
  emptyDeck,
  learningCurve,
  nextDueAt,
  nextSkill,
  readDeck,
  recordAnswer,
  writeDeck,
} from '../leitner.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe('the Leitner deck', () => {
  beforeEach(() => { clearDeck(); });

  it('starts with every skill in the first box and due now', () => {
    const deck = emptyDeck(T0);
    expect(dueSkills(deck, T0)).toHaveLength(SKILLS.length);
    expect(SKILLS.every((s) => deck.skills[s.id].box === 1)).toBe(true);
  });

  it('moves a skill up a box when answered right, and out of the due list for that box’s interval', () => {
    let deck = emptyDeck(T0);
    deck = recordAnswer(deck, 'clock-victim', true, T0);
    expect(deck.skills['clock-victim']).toMatchObject({ box: 2, asked: 1, right: 1 });
    expect(deck.skills['clock-victim'].due).toBe(T0 + BOX_DAYS[1]! * DAY);
    expect(dueSkills(deck, T0)).not.toContain('clock-victim');
    expect(dueSkills(deck, T0 + DAY)).toContain('clock-victim');
  });

  it('sends a skill back to the first box, due at once, when answered wrong', () => {
    let deck = emptyDeck(T0);
    for (let i = 0; i < 3; i += 1) deck = recordAnswer(deck, 'visibility', true, T0);
    expect(deck.skills.visibility.box).toBe(4);
    deck = recordAnswer(deck, 'visibility', false, T0 + 1);
    expect(deck.skills.visibility).toMatchObject({ box: 1, asked: 4, right: 3 });
    expect(dueSkills(deck, T0 + 1)).toContain('visibility');
  });

  it('stops at the last box', () => {
    let deck = emptyDeck(T0);
    for (let i = 0; i < 12; i += 1) deck = recordAnswer(deck, 'losers', true, T0);
    expect(deck.skills.losers.box).toBe(BOXES);
  });

  it('asks the lowest box first, then the longest overdue', () => {
    let deck = emptyDeck(T0);
    deck = recordAnswer(deck, 'clock-victim', true, T0 - 10 * DAY);
    deck = recordAnswer(deck, 'clock-victim', true, T0 - 10 * DAY);
    const order = dueSkills(deck, T0 + 30 * DAY);
    expect(order.at(-1)).toBe('clock-victim');
    expect(order[0]).not.toBe('clock-victim');
  });

  it('offers practice anyway when nothing is due, and says when something will be', () => {
    let deck = emptyDeck(T0);
    for (const s of SKILLS) deck = recordAnswer(deck, s.id, true, T0);
    expect(nextSkill(deck, T0)).toBeNull();
    expect(nextSkill(deck, T0, true)).not.toBeNull();
    expect(nextDueAt(deck, T0)).toBe(T0 + DAY);
    expect(nextDueAt(emptyDeck(T0), T0)).toBeNull();
  });

  it('measures the first ask of each skill apart from the rest', () => {
    let deck = emptyDeck(T0);
    deck = recordAnswer(deck, 'clock-victim', false, T0);
    deck = recordAnswer(deck, 'clock-victim', true, T0);
    deck = recordAnswer(deck, 'losers', true, T0);
    expect(learningCurve(deck)).toEqual({ first: { asked: 2, right: 1 }, later: { asked: 1, right: 1 } });
  });

  it('is kept, and read back, and survives garbage', () => {
    let deck = emptyDeck(T0);
    deck = recordAnswer(deck, 'access-path', true, T0);
    writeDeck(deck);
    expect(readDeck(T0).skills['access-path']).toMatchObject({ box: 2, asked: 1 });
    localStorage.setItem('querylens:practice', '{"skills": 7, "history": [null, 3]}');
    expect(readDeck(T0).skills['access-path']).toMatchObject({ box: 1, asked: 0 });
    localStorage.setItem('querylens:practice', 'not json');
    expect(readDeck(T0).history).toEqual([]);
  });
});
