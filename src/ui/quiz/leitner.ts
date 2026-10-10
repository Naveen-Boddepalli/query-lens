/**
 * A Leitner box scheduler (plan.md §25.4 G4). Five boxes; a skill answered right moves up a box and is not asked
 * again for longer; answered wrong, it goes back to the first box and is asked again at once. The unit is a *skill*
 * (clock sweep, B+Tree split, …), not a question: every time it comes round the question is a fresh instance, so the
 * box measures whether the idea is stable, not whether one answer was remembered.
 *
 * Pure functions with the clock passed in, and a stored deck that is a convenience — a browser that will not keep it
 * degrades to starting over, never to an error. Per-browser; nothing leaves it.
 */

import { SKILLS } from './generators.ts';
import type { SkillId } from './generators.ts';

export const BOXES = 5;
const DAY = 24 * 60 * 60 * 1000;

/** Days until a skill in box 1 … 5 is due again. */
export const BOX_DAYS: readonly number[] = [0, 1, 3, 7, 14];

export interface SkillState {
  /** 1 … `BOXES`. */
  box: number;
  /** When it is next due, in epoch milliseconds. */
  due: number;
  asked: number;
  right: number;
}

export interface Attempt {
  skill: SkillId;
  correct: boolean;
  at: number;
  /** The first time this skill was ever asked. */
  first: boolean;
}

export interface Deck {
  skills: Record<SkillId, SkillState>;
  /** The newest attempts, oldest first, capped. */
  history: Attempt[];
}

const HISTORY_CAP = 300;
const KEY = 'querylens:practice';

export function emptyDeck(now: number): Deck {
  const skills = {} as Record<SkillId, SkillState>;
  for (const s of SKILLS) skills[s.id] = { box: 1, due: now, asked: 0, right: 0 };
  return { skills, history: [] };
}

export function recordAnswer(deck: Deck, skill: SkillId, correct: boolean, now: number): Deck {
  const was = deck.skills[skill];
  const box = correct ? Math.min(BOXES, was.box + 1) : 1;
  const next: SkillState = {
    box,
    due: now + (BOX_DAYS[box - 1] ?? 0) * DAY,
    asked: was.asked + 1,
    right: was.right + (correct ? 1 : 0),
  };
  const history = [...deck.history, { skill, correct, at: now, first: was.asked === 0 }].slice(-HISTORY_CAP);
  return { skills: { ...deck.skills, [skill]: next }, history };
}

/** The skills that are due, lowest box first, then the longest overdue. */
export function dueSkills(deck: Deck, now: number): SkillId[] {
  return SKILLS.map((s) => s.id)
    .filter((id) => deck.skills[id].due <= now)
    .sort((a, b) => deck.skills[a].box - deck.skills[b].box || deck.skills[a].due - deck.skills[b].due);
}

/** The skill to ask next: a due one, or — with `anyway` — the weakest, so that practice is never refused. */
export function nextSkill(deck: Deck, now: number, anyway = false): SkillId | null {
  const due = dueSkills(deck, now);
  if (due.length > 0) return due[0]!;
  if (!anyway) return null;
  return SKILLS.map((s) => s.id).sort((a, b) => deck.skills[a].box - deck.skills[b].box || deck.skills[a].due - deck.skills[b].due)[0] ?? null;
}

/** When the next skill comes due, or null if one already is. */
export function nextDueAt(deck: Deck, now: number): number | null {
  const future = SKILLS.map((s) => deck.skills[s.id].due).filter((d) => d > now);
  if (future.length < SKILLS.length) return null;
  return Math.min(...future);
}

/** Right on the first ask of a skill, against right on every ask after it: the page's own small measurement. */
export function learningCurve(deck: Deck): { first: { asked: number; right: number }; later: { asked: number; right: number } } {
  const out = { first: { asked: 0, right: 0 }, later: { asked: 0, right: 0 } };
  for (const a of deck.history) {
    const bucket = a.first ? out.first : out.later;
    bucket.asked += 1;
    if (a.correct) bucket.right += 1;
  }
  return out;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function readDeck(now: number): Deck {
  const fresh = emptyDeck(now);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as { skills?: Record<string, Partial<SkillState>>; history?: unknown };
    for (const s of SKILLS) {
      const stored = parsed.skills?.[s.id];
      if (!stored) continue;
      fresh.skills[s.id] = {
        box: Math.min(BOXES, Math.max(1, count(stored.box) || 1)),
        due: typeof stored.due === 'number' && Number.isFinite(stored.due) ? stored.due : now,
        asked: count(stored.asked),
        right: count(stored.right),
      };
    }
    if (Array.isArray(parsed.history)) {
      const ids = new Set<string>(SKILLS.map((s) => s.id));
      fresh.history = (parsed.history as Partial<Attempt>[])
        .filter((a) => typeof a.skill === 'string' && ids.has(a.skill) && typeof a.correct === 'boolean' && typeof a.at === 'number')
        .map((a) => ({ skill: a.skill as SkillId, correct: a.correct!, at: a.at!, first: a.first === true }))
        .slice(-HISTORY_CAP);
    }
    return fresh;
  } catch {
    return fresh;
  }
}

export function writeDeck(deck: Deck): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(deck));
  } catch {
    // Not kept this session; nothing depends on it.
  }
}

export function clearDeck(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
