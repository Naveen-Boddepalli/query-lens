import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { uniqueViolation, validate } from '../index/index.ts';
import type { BPlusTree } from '../index/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { Database, PlanNode, Row, StepEvent, Table } from '../types.ts';

/**
 * `UNIQUE` (plan.md §25.4 B3c): a unique constraint is an index lookup made before a key goes in. A statement that
 * would repeat a key is rejected with the trace of how far it got, and changes nothing.
 */

function accounts(extra: Partial<Table> = {}): Database {
  const rows: Row[] = [
    { id: 1, email: 'ada@x.org', team: 'a', role: 'admin' },
    { id: 2, email: 'alan@x.org', team: 'a', role: 'dev' },
    { id: 3, email: 'grace@x.org', team: 'b', role: 'dev' },
    { id: 4, email: null, team: 'b', role: null },
    { id: 5, email: null, team: 'c', role: null },
  ];
  return {
    tables: {
      accounts: {
        name: 'accounts',
        columns: ['id', 'email', 'team', 'role'],
        rows,
        indexes: [{ columns: ['id'], unique: true }, { columns: ['email'], unique: true }],
        ...extra,
      },
    },
  };
}

const run = (sql: string, db: Database = accounts()) => runQuery(sql, db);
const text = (events: StepEvent[]) => events.map((e) => e.label).join('\n');
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.children ?? []).flatMap(flatten)];

describe('INSERT', () => {
  it('a key already in the index is rejected, and nothing is written', () => {
    const { error, write, rows } = run("INSERT INTO accounts (id, email, team, role) VALUES (6, 'ada@x.org', 'c', 'dev')");
    expect(error?.message).toBe("Duplicate key — the UNIQUE index on `email` already holds (email) = ('ada@x.org').");
    expect(error?.hint).toContain('Nothing was changed');
    expect(error?.hint).toContain('"id":1');
    expect(error?.from).toBeDefined();
    expect(write).toBeUndefined();
    expect(rows).toEqual([]);
  });

  it('shows the lookup that found it: the check, the descent, and the rejection', () => {
    const { events } = run("INSERT INTO accounts (id, email, team, role) VALUES (6, 'ada@x.org', 'c', 'dev')");
    const said = text(events);
    expect(said).toContain("INSERT checks the UNIQUE index on `email` before it changes anything: is there already an entry for (email) = ('ada@x.org')?");
    expect(events.some((e) => e.stage === 'index' && e.action === 'found')).toBe(true);
    expect(said).toContain("the key is already taken, so INSERT will be rejected");
    // The statement ends with a result event, so the trace closes instead of stopping mid-sentence.
    expect(events.at(-1)?.stage).toBe('result');
    expect(events.at(-1)?.label).toContain('INSERT is rejected');
    // And it changed nothing: no heap write, no index insert.
    expect(events.some((e) => e.stage === 'buffer' && e.action === 'write')).toBe(false);
    expect(said).not.toContain('B+Tree gets key');
  });

  it('a free key is checked, found absent, and inserted', () => {
    const { error, write, events } = run("INSERT INTO accounts (id, email, team, role) VALUES (6, 'new@x.org', 'c', 'dev')");
    expect(error).toBeUndefined();
    expect(write?.rows).toHaveLength(6);
    expect(text(events)).toContain("No entry for (email) = ('new@x.org'), so the key is free and INSERT goes on.");
  });

  it('checks every unique index, and reports the first one that is taken', () => {
    const { error } = run("INSERT INTO accounts (id, email, team, role) VALUES (2, 'fresh@x.org', 'c', 'dev')");
    expect(error?.message).toContain('`id`');
    expect(error?.message).toContain('(id) = (2)');
  });

  it('NULL is not equal to NULL: any number of rows may hold one', () => {
    const { error, write, events } = run("INSERT INTO accounts (id, email, team, role) VALUES (6, NULL, 'c', 'dev')");
    expect(error).toBeUndefined();
    expect(write?.rows.filter((r) => r.email === null)).toHaveLength(3);
    expect(text(events)).toContain('NULL is not equal to NULL');
  });
});

describe('UPDATE', () => {
  it('giving a row a key another row holds is rejected, and no row changes', () => {
    const { error, write } = run("UPDATE accounts SET email = 'alan@x.org' WHERE id = 1");
    expect(error?.message).toContain("(email) = ('alan@x.org')");
    expect(write).toBeUndefined();
  });

  it('a row may keep its own key, take a free one, or change a column no unique index covers', () => {
    expect(run("UPDATE accounts SET email = 'ada@x.org' WHERE id = 1").error).toBeUndefined();
    expect(run("UPDATE accounts SET email = 'ada@new.org' WHERE id = 1").write?.rows.find((r) => r.id === 1)?.email).toBe('ada@new.org');
    expect(run("UPDATE accounts SET role = 'ops' WHERE team = 'a'").write?.rows.filter((r) => r.role === 'ops')).toHaveLength(2);
  });

  it('a statement that breaks the constraint on its second row changes neither', () => {
    // Both rows of team "a" get the same email: the first succeeds, the second finds it taken.
    const { error, write } = run("UPDATE accounts SET email = 'same@x.org' WHERE team = 'a'");
    expect(error?.message).toContain("(email) = ('same@x.org')");
    expect(write).toBeUndefined();
  });

  it('the trace says what it checked, and closes with the rejection', () => {
    const { events } = run("UPDATE accounts SET email = 'alan@x.org' WHERE id = 1");
    expect(text(events)).toContain("UPDATE checks the UNIQUE index on `email` before it changes anything");
    expect(events.at(-1)?.label).toContain('UPDATE is rejected');
  });

  it('setting a key to NULL is always allowed', () => {
    expect(run('UPDATE accounts SET email = NULL WHERE id = 1').write?.rows.filter((r) => r.email === null)).toHaveLength(3);
  });
});

describe('DELETE frees the key', () => {
  it('a key can be reused once the row that held it is gone', () => {
    const after = run("DELETE FROM accounts WHERE email = 'ada@x.org'");
    const db: Database = { tables: { accounts: { ...accounts().tables.accounts!, rows: after.write!.rows } } };
    expect(run("INSERT INTO accounts (id, email, team, role) VALUES (9, 'ada@x.org', 'c', 'dev')", db).error).toBeUndefined();
  });
});

describe('a composite UNIQUE index', () => {
  const db = (): Database => accounts({ indexes: [{ columns: ['team', 'role'], unique: true }] });

  it('is unique over the pair, not over either column', () => {
    expect(run("INSERT INTO accounts (id, email, team, role) VALUES (6, 'x@x.org', 'a', 'ops')", db()).error).toBeUndefined();
    const dup = run("INSERT INTO accounts (id, email, team, role) VALUES (7, 'y@x.org', 'a', 'admin')", db());
    expect(dup.error?.message).toContain("(team, role) = ('a', 'admin')");
  });

  it('a NULL anywhere in the key means it conflicts with nothing', () => {
    expect(run("INSERT INTO accounts (id, email, team, role) VALUES (6, 'x@x.org', 'b', NULL)", db()).error).toBeUndefined();
  });
});

describe('the plan and the lookup', () => {
  it('an equality on the whole key says the index is unique, and returns one row', () => {
    const { rows, events } = run("SELECT * FROM accounts WHERE email = 'grace@x.org'");
    expect(rows.map((r) => r.id)).toEqual([3]);
    expect(text(events.filter((e) => e.stage === 'optimize'))).toContain('The index is UNIQUE');
  });

  it('stops at the first entry: no run to read, no sibling leaf to look at', () => {
    const many: Row[] = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, k: `k${String(i).padStart(2, '0')}` }));
    const db: Database = { tables: { t: { name: 't', columns: ['id', 'k'], rows: many, indexes: [{ columns: ['k'], unique: true }] } } };
    const { events } = runQuery("SELECT * FROM t WHERE k = 'k17'", db);
    expect(events.filter((e) => e.stage === 'index' && e.action === 'chain-next')).toHaveLength(0);
  });

  it('is an index like any other for the optimizer to choose between', () => {
    const nodes = flatten(
      (run("SELECT * FROM accounts WHERE id = 3 AND email = 'grace@x.org'").events.filter((e): e is Extract<StepEvent, { stage: 'optimize' }> => e.stage === 'optimize').at(-1))!.after,
    );
    expect(nodes.some((n) => n.op === 'IndexScan')).toBe(true);
  });
});

describe('after a successful write the unique index is still sound', () => {
  it('holds one entry per row', () => {
    const captured: Record<string, BPlusTree> = {};
    const { write } = runQuery("INSERT INTO accounts (id, email, team, role) VALUES (6, 'n@x.org', 'c', 'dev')", accounts(), DEFAULT_ENGINE_OPTIONS, {
      afterWrite: (t) => Object.assign(captured, t),
    });
    for (const tree of Object.values(captured)) expect(validate(tree)).toEqual([]);
    expect(write?.rows).toHaveLength(6);
  });
});

describe('uniqueViolation — the same rule over a whole table', () => {
  const table = accounts().tables.accounts!;
  it('finds nothing in rows that keep it', () => {
    expect(uniqueViolation(table, table.rows)).toBeNull();
  });

  it('names the index and key of the first repeat, and ignores NULLs', () => {
    const rows = [...table.rows, { id: 9, email: 'ada@x.org', team: 'z', role: null }];
    expect(uniqueViolation(table, rows)).toEqual({ index: 'email', columns: ['email'], values: ['ada@x.org'] });
    expect(uniqueViolation(table, [{ id: 1, email: null }, { id: 2, email: null }])).toBeNull();
  });

  it('a table with no unique index never has a violation', () => {
    expect(uniqueViolation({ indexedColumns: ['id'] }, [{ id: 1 }, { id: 1 }])).toBeNull();
  });
});
