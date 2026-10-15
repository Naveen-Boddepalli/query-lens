import { describe, expect, it } from 'vitest';
import { LESSONS, lessonById, stepLink } from '../lessons.tsx';

/**
 * The lesson prose is not tested — it is copy. What is tested is the same
 * thing `GalleryPage`'s test pins: every deep link a lesson hands out is
 * computed from a real engine run, so if a stage moves, this fails here
 * rather than shipping a link to the wrong step.
 */
describe('learn lessons', () => {
  it('has unique ids and at least one step each', () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lesson of LESSONS) expect(lesson.steps.length).toBeGreaterThan(0);
  });

  it('lessonById round-trips and rejects the unknown', () => {
    for (const lesson of LESSONS) expect(lessonById(lesson.id)).toBe(lesson);
    expect(lessonById('nope')).toBeUndefined();
    expect(lessonById(undefined)).toBeUndefined();
  });

  it('every step link resolves to a real Playground step', () => {
    for (const lesson of LESSONS) {
      for (const [i, step] of lesson.steps.entries()) {
        if (!step.open) continue;
        const { href, label } = stepLink(step.open);
        expect(label.length, `${lesson.id} step ${String(i)}`).toBeGreaterThan(0);
        const url = new URL(href, 'https://x');
        expect(url.pathname).toBe('/playground');
        const step_ = Number(url.searchParams.get('s'));
        expect(Number.isInteger(step_) && step_ >= 1, `${lesson.id} step ${String(i)} → ${href}`).toBe(
          true,
        );
        expect(url.searchParams.get('q')).toBeTruthy();
      }
    }
  });

  it('at least one lesson opens a step with prediction on', () => {
    const any = LESSONS.some((l) => l.steps.some((s) => s.open?.predictOn));
    expect(any).toBe(true);
  });

  it('every fixed step link is an in-app path', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (!step.link) continue;
        expect(step.link.label.length).toBeGreaterThan(0);
        expect(step.link.href.startsWith('/'), `${lesson.id}: ${step.link.href}`).toBe(true);
      }
    }
  });

  it('every lesson has valid difficulty and category metadata', () => {
    const validDifficulties = new Set(['Beginner', 'Intermediate', 'Advanced']);
    const validCategories = new Set(['Foundations', 'Storage', 'Optimizer', 'Workflows']);
    for (const lesson of LESSONS) {
      expect(validDifficulties.has(lesson.difficulty), `${lesson.id} invalid difficulty`).toBe(true);
      expect(validCategories.has(lesson.category), `${lesson.id} invalid category`).toBe(true);
      expect(lesson.minutes).toBeGreaterThan(0);
    }
  });

  it('checkpoint predictions have valid questions, options, and correctOptionId', () => {
    let checkpointCount = 0;
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (!step.checkpointPrediction) continue;
        checkpointCount++;
        const p = step.checkpointPrediction;
        expect(p.question.length).toBeGreaterThan(0);
        expect(p.options.length).toBeGreaterThanOrEqual(2);
        expect(p.options.some((o) => o.id === p.correctOptionId)).toBe(true);
        expect(p.explanation.length).toBeGreaterThan(0);
      }
    }
    expect(checkpointCount).toBeGreaterThanOrEqual(5);
  });
});
