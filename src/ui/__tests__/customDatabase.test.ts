import { beforeEach, describe, expect, it } from 'vitest';
import {
  isValidName,
  loadCustomDatabase,
  parseColumnList,
  saveCustomDatabase,
  starterCustomDatabase,
  validateNewTable,
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

describe('loadCustomDatabase / saveCustomDatabase', () => {
  beforeEach(() => { localStorage.clear(); });

  it('falls back to the starter when nothing is stored', () => {
    expect(loadCustomDatabase()).toEqual(starterCustomDatabase());
  });

  it('round-trips a saved database', () => {
    const db: Database = {
      tables: {
        widgets: { name: 'widgets', columns: ['id', 'label'], rows: [{ id: 1, label: 'x' }], indexedColumn: 'id' },
      },
    };
    saveCustomDatabase(db);
    expect(loadCustomDatabase()).toEqual(db);
  });

  it('falls back to the starter on corrupt JSON', () => {
    localStorage.setItem('querylens.customDatabase.v1', '{not json');
    expect(loadCustomDatabase()).toEqual(starterCustomDatabase());
  });

  it('rejects the whole thing on a single bad row rather than half-loading it', () => {
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [{ id: 1, extra: 2 }] } } }),
    );
    expect(loadCustomDatabase()).toEqual(starterCustomDatabase());
  });

  it("rejects a table whose declared name doesn't match its own key", () => {
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { widgets: { name: 'gadgets', columns: ['id'], rows: [] } } }),
    );
    expect(loadCustomDatabase()).toEqual(starterCustomDatabase());
  });

  it('rejects an indexedColumn that names a column the table does not have', () => {
    localStorage.setItem(
      'querylens.customDatabase.v1',
      JSON.stringify({ tables: { widgets: { name: 'widgets', columns: ['id'], rows: [], indexedColumn: 'bogus' } } }),
    );
    expect(loadCustomDatabase()).toEqual(starterCustomDatabase());
  });
});
