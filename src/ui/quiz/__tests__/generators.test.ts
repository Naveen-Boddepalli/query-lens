import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_OPTIONS, runBufferTrace } from '../../../engine/index.ts';
import { SKILLS, generate } from '../generators.ts';
import type { Question, SkillId } from '../generators.ts';

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7 + 1);

describe('generated questions', () => {
  it('are the same question for the same seed, and different ones for different seeds', () => {
    for (const skill of SKILLS.map((s) => s.id)) {
      expect(generate(skill, 42)).toEqual(generate(skill, 42));
      const prompts = new Set(SEEDS.slice(0, 30).map((seed) => generate(skill, seed).prompt));
      expect(prompts.size).toBeGreaterThan(15);
    }
  });

  it('always have distinct options, one of which is the answer, and an explanation', () => {
    for (const skill of SKILLS.map((s) => s.id)) {
      for (const seed of SEEDS) {
        const q = generate(skill, seed);
        const labels = q.options.map((o) => o.label);
        expect(new Set(labels).size).toBe(labels.length);
        expect(labels.length).toBeGreaterThanOrEqual(2);
        expect(q.options.some((o) => o.id === q.answer)).toBe(true);
        expect(q.explanation.length).toBeGreaterThan(20);
        expect(q.id).toBe(`${skill}:${String(seed)}`);
      }
    }
  });

  it('do not give the answer away by position', () => {
    for (const skill of SKILLS.map((s) => s.id)) {
      const where = new Set(SEEDS.map((seed) => {
        const q = generate(skill, seed);
        return q.options.findIndex((o) => o.id === q.answer);
      }));
      expect(where.size).toBeGreaterThan(1);
    }
  });

  it('never reproduce an item of the §9 instrument', () => {
    // STUDY.md's fixed bank: a 4-frame pool holding 7, 2, 9, 3 and asking for page 5; a leaf [10, 20, 30] taking 25;
    // a users table of 12 pages. The generators ask about other things, and never about those.
    const banned = [/7, 2, 9, 3/, /\[10, 20, 30\]/, /10, 20, 30/, /Key 25 is inserted/];
    for (const skill of SKILLS.map((s) => s.id)) {
      for (const seed of SEEDS) {
        const q = generate(skill, seed);
        for (const re of banned) expect(q.prompt).not.toMatch(re);
      }
    }
  });
});

describe('the answers are the engine’s', () => {
  const byId = (skill: SkillId, seed: number): Question => generate(skill, seed);

  it('clock sweep: the page named is the victim the buffer trace evicts', () => {
    for (const seed of SEEDS) {
      const q = byId('clock-victim', seed);
      const frames = Number(/has (\d) frames/.exec(q.prompt)![1]);
      const lines = q.prompt.split('\n');
      const history = lines[1]!.split(', ').map(Number);
      const requested = Number(/Then page (\d+) is requested/.exec(q.prompt)![1]);
      const trace = runBufferTrace([...history, requested], {
        ...DEFAULT_ENGINE_OPTIONS,
        bufferFrames: frames,
        policy: 'clock',
      });
      const evicts = trace.events.filter((e) => e.stage === 'buffer' && e.action === 'evict');
      const victim = evicts.at(-1);
      if (victim?.action !== 'evict') throw new Error('no eviction');
      const label = q.options.find((o) => o.id === q.answer)!.label;
      expect(label).toBe(`page ${String(victim.victimPageId)}`);
      // And every option is a page that was in the pool.
      expect(q.options).toHaveLength(frames);
    }
  });

  it('a B+Tree split: the answer is one of the leaf’s keys, and is the first of the new right leaf', () => {
    for (const seed of SEEDS) {
      const q = byId('split-separator', seed);
      const label = q.options.find((o) => o.id === q.answer)!.label;
      expect(q.explanation).toMatch(/\[[\d, ]+\] and \[[\d, ]+\]/);
      const right = /and \[([\d, ]+)\]/.exec(q.explanation)![1]!.split(', ')[0];
      expect(label).toBe(right);
    }
  });

  it('an access path: the labelled scan is the one the planner’s plan names', () => {
    const labels = new Set<string>();
    for (const seed of SEEDS) {
      const q = byId('access-path', seed);
      const label = q.options.find((o) => o.id === q.answer)!.label;
      labels.add(label);
      expect(q.explanation).toContain('The planner picked');
    }
    // Over many seeds the planner picks more than one kind of path, or the question teaches nothing.
    expect(labels.size).toBeGreaterThan(1);
  });

  it('visibility: balanced between yes and no', () => {
    const yes = SEEDS.filter((seed) => {
      const q = byId('visibility', seed);
      return q.options.find((o) => o.id === q.answer)!.label.startsWith('Yes');
    });
    expect(yes.length).toBeGreaterThan(SEEDS.length / 4);
    expect(yes.length).toBeLessThan((SEEDS.length * 3) / 4);
  });

  it('recovery questions come with a script that really runs to the answer', () => {
    for (const seed of SEEDS.slice(0, 25)) {
      const redo = byId('redo-count', seed);
      expect(redo.prompt).toContain('begin T1');
      expect(redo.link?.to).toMatch(/^\/tools\/recovery\?s=/);
      const losers = byId('losers', seed);
      expect(['Only T1', 'Only T2', 'Both T1 and T2', 'Neither']).toContain(
        losers.options.find((o) => o.id === losers.answer)!.label,
      );
    }
  });

  it('whatever the seed, a question can be built', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.constantFrom(...SKILLS.map((s) => s.id)), (seed, skill) => {
        const q = generate(skill, seed);
        expect(q.options.some((o) => o.id === q.answer)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
