import { describe, expect, it } from 'vitest';
import {
  describeIndexes,
  isValidName,
  databaseOrStarter,
  parseColumnList,
  parseCompositeIndexes,
  parseUniqueIndexes,
  starterCustomDatabase,
  validateCompositeIndexes,
  validateNewTable,
  validateUniqueRows,
} from '../customDatabase.ts';
import type { Database } from '../../engine/index.ts';

describe('isValidName', () => {
  it.each(['authors', '_x1', 'posts2', 'a_b_c'])('accepts %s', (name) => {
    expect(isValidName(name)).toBe(true);
  });

  it.each(['5abc', 'my table', 'a-b', '', 'select', 'JOIN', 'a.b', 'a;b'])('rejects %s', (name) => {
    expect(isValidName(name)).toBe(false);
  });
});

describe('parseColumnList', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseColumnList('id, name ,  , age')).toEqual(['id', 'name', 'age']);
  });

  it('an empty string yields no columns', () => {
    expect(parseColumnList('')).toEqual([]);
  });
});

describe('composite indexes (plan.md §25.4 B3b)', () => {
  it('parses columns joined by + into one index each, and drops a single column (that is the ordinary index)', () => {
    expect(parseCompositeIndexes('a+b, c + d + e, f')).toEqual([['a', 'b'], ['c', 'd', 'e']]);
    expect(parseCompositeIndexes('')).toEqual([]);
  });

  it('accepts columns the table has, in any order, and refuses the rest with a reason', () => {
    expect(validateCompositeIndexes(['a', 'b', 'c'], [['b', 'a']])).toBeNull();
    expect(validateCompositeIndexes(['a', 'b'], [['a', 'z']])).toContain('"z"');
    expect(validateCompositeIndexes(['a', 'b'], [['a', 'a']])).toContain('twice');
    expect(validateCompositeIndexes(['a', 'b'], [['a', 'b'], ['a', 'b']])).toContain('declared twice');
  });

  it('describes a table\'s indexes, plain and composite', () => {
    expect(describeIndexes({})).toBe('');
    expect(describeIndexes({ indexedColumns: ['id'] })).toBe('indexed on id');
    expect(describeIndexes({ indexedColumns: ['id'], indexes: [{ columns: ['a', 'b'] }] })).toBe('indexed on id · composite (a, b)');
    expect(describeIndexes({ indexes: [{ columns: ['a', 'b'] }, { columns: ['c', 'd', 'e'] }] })).toBe('composite (a, b), (c, d, e)');
  });

  it('UNIQUE indexes use the same syntax, and one column is enough', () => {
    expect(parseUniqueIndexes('email, team + role,')).toEqual([['email'], ['team', 'role']]);
    expect(describeIndexes({ indexedColumns: ['id'], indexes: [{ columns: ['email'], unique: true }, { columns: ['a', 'b'] }] })).toBe(
      'indexed on id · composite (a, b) · unique (email)',
    );
    // A column declared both plain and unique is described once, as unique.
    expect(describeIndexes({ indexedColumns: ['email'], indexes: [{ columns: ['email'], unique: true }] })).toBe('unique (email)');
  });

  it('rows that repeat a unique key are refused with the key; NULLs never conflict', () => {
    const table = (rows: Database['tables'][string]['rows']) => ({
      tables: { t: { name: 't', columns: ['id', 'email'], rows, indexes: [{ columns: ['email'], unique: true }] } },
    });
    expect(validateUniqueRows(table([{ id: 1, email: 'a' }, { id: 2, email: 'b' }]))).toBeNull();
    expect(validateUniqueRows(table([{ id: 1, email: null }, { id: 2, email: null }]))).toBeNull();
    expect(validateUniqueRows(table([{ id: 1, email: 'a' }, { id: 2, email: 'a' }]))).toContain("(email) = ('a')");
  });

  describe('a stored database with composite indexes', () => {
    const withIndexes = (indexes: unknown): unknown => ({
      tables: { t: { name: 't', columns: ['a', 'b'], rows: [], indexes } },
    });

    it('round-trips', () => {
      const db: Database = { tables: { t: { name: 't', columns: ['a', 'b'], rows: [{ a: 1, b: 2 }], indexes: [{ columns: ['a', 'b'] }] } } };
      expect(databaseOrStarter(db)).toEqual(db);
    });

    it.each([
      ['a column the table lacks', [{ columns: ['a', 'zzz'] }]],
      ['no columns', [{ columns: [] }]],
      ['a repeated column', [{ columns: ['a', 'a'] }]],
      ['the same index twice', [{ columns: ['a', 'b'] }, { columns: ['a', 'b'] }]],
      ['a non-array', 'a+b'],
    ])('falls back to the starter for %s', (_, indexes) => {
      expect(Object.keys(databaseOrStarter(withIndexes(indexes)).tables).sort()).toEqual(['authors', 'posts']);
    });
  });
});

describe('starterCustomDatabase', () => {
  it('is a real two-table, joinable database', () => {
    const db = starterCustomDatabase();
    expect(Object.keys(db.tables).sort()).toEqual(['authors', 'posts']);
    expect(db.tables.authors!.rows.length).toBeGreaterThan(0);
    expect(db.tables.posts!.rows.length).toBeGreaterThan(0);
  });

  it('returns a fresh object each call — mutating one copy never leaks into the next', () => {
    const a = starterCustomDatabase();
    a.tables.authors!.rows.push({ id: 999, name: 'mutated' });
    const b = starterCustomDatabase();
    expect(b.tables.authors!.rows).not.toContainEqual({ id: 999, name: 'mutated' });
  });
});

describe('validateNewTable', () => {
  const db: Database = { tables: { authors: { name: 'authors', columns: ['id'], rows: [] } } };

  it('accepts a well-formed new table', () => {
    expect(validateNewTable(db, { name: 'reviews', columns: ['id', 'rating'] })).toBeNull();
  });

  it('rejects a blank name', () => {
    expect(validateNewTable(db, { name: '', columns: ['id'] })).toMatch(/name the table/i);
  });

  it('rejects an invalid identifier', () => {
    expect(validateNewTable(db, { name: '5reviews', columns: ['id'] })).toMatch(/valid table name/);
  });

  it('rejects a name already in use', () => {
    expect(validateNewTable(db, { name: 'authors', columns: ['id'] })).toMatch(/already exists/);
  });

  it('rejects zero columns', () => {
    expect(validateNewTable(db, { name: 'reviews', columns: [] })).toMatch(/at least one column/);
  });

  it('rejects an invalid column name', () => {
    expect(validateNewTable(db, { name: 'reviews', columns: ['5bad'] })).toMatch(/valid column name/);
  });

  it('rejects a duplicate column', () => {
    expect(validateNewTable(db, { name: 'reviews', columns: ['id', 'id'] })).toMatch(/listed twice/);
  });
});

describe('databaseOrStarter', () => {

  it('falls back to the starter when nothing is stored', () => {
    expect(databaseOrStarter(undefined)).toEqual(starterCustomDatabase());
  });

  it('round-trips a saved database', () => {
    const db: Database = {
      tables: {
        widgets: { name: 'widgets', columns: ['id', 'label'], rows: [{ id: 1, label: 'x' }], indexedColumns: ['id', 'label'] },
      },
    };
    expect(databaseOrStarter(db)).toEqual(db);
  });

  it('falls back to the starter on corrupt JSON', () => {
    expect(databaseOrStarter('{not json')).toEqual(starterCustomDatabase());
  });

  it('rejects the whole thing on a single bad row rather than half-loading it', () => {
    expect(databaseOrStarter({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [{ id: 1, extra: 2 }] } } })).toEqual(starterCustomDatabase());
  });

  it("rejects a table whose declared name doesn't match its own key", () => {
    expect(databaseOrStarter({ tables: { widgets: { name: 'gadgets', columns: ['id'], rows: [] } } })).toEqual(starterCustomDatabase());
  });

  it('rejects an indexedColumns entry that names a column the table does not have', () => {
    expect(databaseOrStarter({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [], indexedColumns: ['bogus'] } } })).toEqual(starterCustomDatabase());
  });

  it('rejects a repeated column in indexedColumns', () => {
    expect(databaseOrStarter({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [], indexedColumns: ['id', 'id'] } } })).toEqual(starterCustomDatabase());
  });
});
