import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { StepEvent } from '../types.ts';
import { evictionPrompt, resultPrompt, traversalPrompt } from '../predict.ts';

const db = createSeedDatabase();
const run = (sql: string) => runQuery(sql, db);
const prompts = (events: StepEvent[]) =>
  events.flatMap((e) => (e.predictable ? [{ stage: e.stage, prompt: e.predictable }] : []));

describe('prompt builders', () => {
  it('returns null rather than an unanswerable eviction question', () => {
    const frames = [
      { frameId: 0, pageId: 3, usageCount: 1, pinCount: 0, lastUsedAt: 0, loadedAt: 0 },
    ];
    expect(evictionPrompt(frames, 0, 9, 'lru')).toBeNull();
  });

  it('offers one child option per pointer, covering every range', () => {
    const prompt = traversalPrompt('n1', [10, 20], 5, 0)!;
    expect(prompt.options.map((o) => o.id)).toEqual(['child-0', 'child-1', 'child-2']);
    expect(prompt.correctOptionId).toBe('child-0');
  });

  it('returns null for a traversal with no separators', () => {
    expect(traversalPrompt('n1', [], 5, 0)).toBeNull();
  });

  it('always includes the true answer among the result options', () => {
    for (const [actual, total] of [[0, 48], [1, 48], [9, 48], [48, 48]] as const) {
      const prompt = resultPrompt(actual, total)!;
      expect(prompt.options.map((o) => o.id)).toContain(prompt.correctOptionId);
      expect(prompt.correctOptionId).toBe(`rows-${String(actual)}`);
    }
  });
});

describe('prompts attached to real traces', () => {
  it.each([
    'SELECT * FROM users WHERE id = 5',
    'SELECT * FROM users WHERE age > 30',
    'SELECT * FROM users',
    'SELECT * FROM users WHERE id = 9999',
  ])('every prompt names an option that exists, and it is the truth: %s', (sql) => {
    for (const { prompt } of prompts(run(sql).events)) {
      expect(prompt.options.length, prompt.question).toBeGreaterThanOrEqual(2);
      expect(
        prompt.options.map((o) => o.id),
        prompt.question,
      ).toContain(prompt.correctOptionId);
      expect(new Set(prompt.options.map((o) => o.id)).size).toBe(prompt.options.length);
      expect(prompt.explanation.length).toBeGreaterThan(20);
    }
  });

  it('asks at most once per kind, so playback is not a quiz gauntlet', () => {
    for (const sql of ['SELECT * FROM users WHERE id = 5', 'SELECT * FROM users WHERE age > 30']) {
      const byStage = new Map<string, number>();
      for (const { stage } of prompts(run(sql).events)) {
        byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
      }
      for (const [stage, count] of byStage) expect(count, `${sql} ${stage}`).toBe(1);
      expect(byStage.size).toBeLessThanOrEqual(4);
    }
  });

  it('asks about the eviction the engine actually performs', () => {
    const { events } = run('SELECT * FROM users WHERE age > 30');
    const asked = events.find((e) => e.predictable && e.stage === 'buffer');
    expect(asked).toBeDefined();
    if (asked?.stage !== 'buffer' || asked.action !== 'evict') throw new Error('wrong event');
    expect(asked.predictable?.correctOptionId).toBe(`frame-${String(asked.frameId)}`);
  });

  it('asks about the child the traversal actually follows', () => {
    const { events } = run('SELECT * FROM users WHERE id = 5');
    const asked = events.find((e) => e.predictable && e.stage === 'index');
    if (asked?.stage !== 'index' || asked.action !== 'traverse') throw new Error('wrong event');
    expect(asked.predictable?.correctOptionId).toBe(`child-${String(asked.childIndex)}`);
  });

  it('asks about the row count the query actually returns', () => {
    for (const sql of ['SELECT * FROM users WHERE id = 5', 'SELECT * FROM users WHERE age > 30']) {
      const { events, rows } = runQuery(sql, db);
      const asked = events.find((e) => e.stage === 'result');
      expect(asked?.predictable?.correctOptionId, sql).toBe(`rows-${String(rows.length)}`);
    }
  });

  it('names the correct victim under each policy', () => {
    for (const policy of ['lru', 'clock'] as const) {
      const { events } = runQuery('SELECT * FROM users WHERE age > 30', db, {
        ...DEFAULT_ENGINE_OPTIONS,
        policy,
      });
      const asked = events.find((e) => e.predictable && e.stage === 'buffer');
      if (asked?.stage !== 'buffer' || asked.action !== 'evict') throw new Error('wrong event');
      // The offered options must include the frame that is really emptied.
      expect(asked.predictable?.options.map((o) => o.id), policy).toContain(
        `frame-${String(asked.frameId)}`,
      );
    }
  });

  it('attaches nothing to a query that errors', () => {
    expect(prompts(run('SELECT * FROM nope').events)).toEqual([]);
  });
});
