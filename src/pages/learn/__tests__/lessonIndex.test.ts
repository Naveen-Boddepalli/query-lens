import { describe, expect, it } from 'vitest';
import { LESSON_GROUPS, LESSON_INDEX, lessonMeta } from '../lessonIndex.ts';
import { LESSON_STEP_IDS, LESSONS, lessonById } from '../lessons.tsx';

/**
 * The manifest is what `/learn` and `/progress` list from, so that they need not load the lessons. The lessons are
 * built from it, so it cannot drift from them by construction; what is left to hold is that nothing is orphaned —
 * no steps without a lesson, no lesson without steps — and that the manifest itself is well formed.
 */
describe('the lesson index', () => {
  it('has the four groups of the track, in order, none of them empty', () => {
    expect(LESSON_GROUPS.map((g) => g.id)).toEqual(['pipeline', 'storage', 'transactions', 'distributed']);
    for (const group of LESSON_GROUPS) {
      expect(group.title.length, group.id).toBeGreaterThan(0);
      expect(group.about.length, group.id).toBeGreaterThan(0);
      expect(group.lessons.length, group.id).toBeGreaterThan(0);
    }
  });

  it('lists each lesson once, with a title, a length and a summary', () => {
    const ids = LESSON_INDEX.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lesson of LESSON_INDEX) {
      expect(lesson.title.length, lesson.id).toBeGreaterThan(0);
      expect(lesson.summary.length, lesson.id).toBeGreaterThan(0);
      expect(Number.isInteger(lesson.minutes) && lesson.minutes > 0, lesson.id).toBe(true);
    }
  });

  it('is the track, in order: the same ids as the lessons, each with its own metadata', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(LESSON_INDEX.map((l) => l.id));
    for (const meta of LESSON_INDEX) {
      const lesson = lessonById(meta.id)!;
      expect([lesson.title, lesson.minutes, lesson.summary]).toEqual([meta.title, meta.minutes, meta.summary]);
      expect(lesson.steps.length, meta.id).toBeGreaterThan(0);
    }
  });

  it('has no steps that no lesson claims, and no lesson without steps', () => {
    const listed = new Set(LESSON_INDEX.map((l) => l.id));
    expect(LESSON_STEP_IDS.filter((id) => !listed.has(id))).toEqual([]);
    const stepped = new Set(LESSON_STEP_IDS);
    expect(LESSON_INDEX.filter((l) => !stepped.has(l.id)).map((l) => l.id)).toEqual([]);
  });

  it('looks a lesson up by id and rejects the unknown', () => {
    for (const lesson of LESSON_INDEX) expect(lessonMeta(lesson.id)).toBe(lesson);
    expect(lessonMeta('nope')).toBeUndefined();
    expect(lessonMeta(undefined)).toBeUndefined();
  });
});
