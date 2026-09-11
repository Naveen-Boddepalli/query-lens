import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

describe('index-only scan — correctness', () => {
  it('returns the key value for a matching row', () => {
    const { rows } = run('SELECT id FROM users WHERE id = 5');
    expect(rows).toEqual([{ id: 5 }]);
  });

  it('returns no rows when the key is not in the table', () => {
    const { rows } = run('SELECT id FROM users WHERE id = 9999');
    expect(rows).toEqual([]);
  });

  it('agrees with the ordinary index lookup on which row matches', () => {
    const indexOnly = run('SELECT id FROM users WHERE id = 5');
    const lookup = run('SELECT id, name FROM users WHERE id = 5');
    expect(indexOnly.rows).toEqual([{ id: lookup.rows[0]!.id }]);
  });

  it('works on a different table and a different index too', () => {
    const orders = DATASETS.orders.make();
    const { rows } = runQuery('SELECT id FROM orders WHERE id = 1', orders);
    expect(rows).toEqual([{ id: 1 }]);
  });
});

describe('index-only scan — the point of the feature: it never touches the heap', () => {
  it('reads exactly one fewer page than an ordinary lookup — the heap page it never fetches', () => {
    const { events } = run('SELECT id FROM users WHERE id = 5');
    const ordinaryLookup = run('SELECT id, name FROM users WHERE id = 5');
    const indexOnlyReads = events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
    const ordinaryReads = ordinaryLookup.events.filter(
      (e) => e.stage === 'buffer' && e.action === 'miss',
    ).length;
    expect(indexOnlyReads).toBeGreaterThan(0);
    expect(indexOnlyReads).toBe(ordinaryReads - 1);
  });

  it('acquires exactly one fewer lock than an ordinary lookup — the heap-page lock it skips', () => {
    const { events } = run('SELECT id FROM users WHERE id = 5');
    const ordinaryLookup = run('SELECT id, name FROM users WHERE id = 5');
    const locksTaken = events.filter((e) => e.stage === 'lock' && e.action === 'acquire').length;
    const ordinaryLocksTaken = ordinaryLookup.events.filter(
      (e) => e.stage === 'lock' && e.action === 'acquire',
    ).length;
    expect(locksTaken).toBe(ordinaryLocksTaken - 1);
  });

  it('the narration says the heap page is never read', () => {
    const { events } = run('SELECT id FROM users WHERE id = 5');
    const found = events.find((e) => e.stage === 'index' && e.action === 'found');
    expect(found?.label).toMatch(/never read/);
  });
});

describe('index-only scan — the pipeline', () => {
  it('walks parse, plan, optimize, index, lock, buffer, execute, result — same named stages as an ordinary lookup', () => {
    const stages = (events: StepEvent[]) => [...new Set(events.map((e) => e.stage))];
    expect(stages(run('SELECT id FROM users WHERE id = 5').events)).toEqual([
      'parse',
      'plan',
      'optimize',
      'index',
      'lock',
      'buffer',
      'execute',
      'result',
    ]);
  });

  it('the optimizer runs all three rules in order: predicate-pushdown, index-selection, index-only-scan', () => {
    const { events } = run('SELECT id FROM users WHERE id = 5');
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['predicate-pushdown', 'index-selection', 'index-only-scan']);
  });

  it('balances every lock it takes', () => {
    let held = 0;
    for (const e of run('SELECT id FROM users WHERE id = 5').events) {
      if (e.stage !== 'lock') continue;
      held += e.action === 'acquire' ? 1 : -1;
    }
    expect(held).toBe(0);
  });

  it('ends with a result event whose rows match', () => {
    const { events, rows } = run('SELECT id FROM users WHERE id = 5');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('is deterministic', () => {
    const a = run('SELECT id FROM users WHERE id = 5');
    const b = run('SELECT id FROM users WHERE id = 5');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('SELECT id FROM users WHERE id = 5');
    expect(structuredClone(events)).toEqual(events);
  });
});
