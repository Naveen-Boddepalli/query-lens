import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../engine/index.ts';
import type { Database } from '../../engine/index.ts';
import { diffRuns, planSignature, readLastRuns, summarize, writeLastRun } from '../traceDiff.ts';
import type { StoredRun } from '../traceDiff.ts';

const KEY = 'querylens.lastRun.v1';

function db(): Database {
  return DATASETS.users.make();
}

function run(sql: string, database: Database = db()) {
  return runQuery(sql, database, DEFAULT_ENGINE_OPTIONS);
}

function stored(overrides: Partial<StoredRun['score']> = {}, signature = 'Project > SeqScan users'): StoredRun {
  return {
    signature,
    score: {
      steps: 10,
      diskReads: 2,
      hits: 1,
      evictions: 0,
      btreeReads: 0,
      locks: 0,
      rows: 5,
      usedIndex: false,
      ...overrides,
    },
  };
}

describe('planSignature', () => {
  it('lists the final plan operators in preorder, joined by arrows', () => {
    const sig = planSignature(run('SELECT * FROM users'));
    expect(sig.startsWith('Project')).toBe(true);
    expect(sig).toContain('SeqScan users');
  });

  it('is empty for a query that never reached the planner', () => {
    expect(planSignature({ events: [], rows: [] })).toBe('');
  });
});

describe('diffRuns', () => {
  it('reports only the numbers that moved, with both values', () => {
    const diff = diffRuns(stored({ rows: 5 }), stored({ rows: 6, diskReads: 4 }));
    expect(diff.changes.map((c) => [c.key, c.before, c.after])).toEqual([
      ['diskReads', 2, 4],
      ['rows', 5, 6],
    ]);
  });

  it('reports no change for identical runs', () => {
    const diff = diffRuns(stored(), stored());
    expect(diff.changes).toEqual([]);
    expect(diff.planChanged).toBe(false);
  });

  it('flags a plan change even when every number is the same', () => {
    const diff = diffRuns(stored({}, 'Project > SeqScan users'), stored({}, 'Project > IndexScan users'));
    expect(diff.changes).toEqual([]);
    expect(diff.planChanged).toBe(true);
    expect(diff.planBefore).toBe('Project > SeqScan users');
    expect(diff.planAfter).toBe('Project > IndexScan users');
  });

  it('sees a real data change: an INSERT between two runs of the same SELECT changes the rows returned', () => {
    const database = db();
    const before = summarize(run('SELECT * FROM users', database));
    const inserted = run("INSERT INTO users VALUES (99, 'new', 'new@example.com', 1)", database);
    expect(inserted.error).toBeUndefined();
    const written: Database = { tables: { users: { ...database.tables.users!, rows: inserted.write!.rows } } };
    const after = summarize(run('SELECT * FROM users', written));
    const diff = diffRuns(before, after);
    expect(diff.changes.find((c) => c.key === 'rows')).toMatchObject({ before: before.score.rows, after: before.score.rows + 1 });
  });
});

describe('last-run storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('round-trips a run keyed by its SQL text', () => {
    writeLastRun('SELECT 1', stored({ rows: 3 }));
    expect(readLastRuns()['SELECT 1']).toEqual(stored({ rows: 3 }));
  });

  it('reads an empty store as nothing, and a corrupt one as nothing rather than throwing', () => {
    expect(readLastRuns()).toEqual({});
    localStorage.setItem(KEY, '{not json');
    expect(readLastRuns()).toEqual({});
  });

  it('ignores individual entries that are not a valid stored run', () => {
    localStorage.setItem(KEY, JSON.stringify({ good: stored(), bad: { score: 'nope' } }));
    expect(Object.keys(readLastRuns())).toEqual(['good']);
  });

  it('keeps only the most recent 20 queries', () => {
    for (let i = 0; i < 25; i++) writeLastRun(`SELECT ${String(i)}`, stored({ rows: i }));
    const keys = Object.keys(readLastRuns());
    expect(keys).toHaveLength(20);
    expect(keys).not.toContain('SELECT 0');
    expect(keys).toContain('SELECT 24');
  });

  it('a re-run moves its query to the most recent position', () => {
    writeLastRun('first', stored());
    writeLastRun('second', stored());
    writeLastRun('first', stored({ rows: 9 }));
    expect(Object.keys(readLastRuns())).toEqual(['second', 'first']);
  });

  it('does not throw when storage refuses writes, and reads as empty when it refuses reads', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => { writeLastRun('SELECT 1', stored()); }).not.toThrow();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readLastRuns()).toEqual({});
  });
});
