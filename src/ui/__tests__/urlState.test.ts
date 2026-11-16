import { describe, expect, it } from 'vitest';
import { createSeedDatabase, DATASETS } from '../../engine/index.ts';
import type { Table } from '../../engine/index.ts';
import {
  encodeShareState,
  otherColumnsOf,
  presetWithRows,
  readDatasetParam,
  readShareState,
  skippedAnswersBefore,
} from '../urlState.ts';

const TABLE = createSeedDatabase().tables.users as Table;
const COLUMNS = TABLE.columns;

describe('share state', () => {
  it('round-trips a moment', () => {
    const query = encodeShareState(
      { sql: 'SELECT * FROM users WHERE id = 5;', policy: 'clock', predictOn: false, step: 13 },
      TABLE,
    );
    expect(readShareState(query, COLUMNS)).toEqual({
      sql: 'SELECT * FROM users WHERE id = 5;',
      policy: 'clock',
      predictOn: false,
      step: 13,
    });
  });

  it('leaves the seed rows out of the link', () => {
    // 48 unchanged rows is ~2 kB of URL saying "nothing was edited".
    const query = encodeShareState(
      { sql: 'SELECT * FROM users;', policy: 'lru', predictOn: true, step: 0 },
      TABLE,
    );
    expect(query).not.toContain('d=');
    expect(readShareState(query, COLUMNS).rows).toBeUndefined();
  });

  it('round-trips an assignment lock, and the lock forces prediction on', () => {
    const query = encodeShareState(
      { sql: 'SELECT * FROM users;', policy: 'lru', predictOn: false, step: 9, lockReveal: true },
      TABLE,
    );
    expect(query).toContain('l=1');
    // `x=0` in the link loses to the lock — the lock is meaningless without
    // prediction on.
    expect(readShareState(query, COLUMNS)).toMatchObject({ lockReveal: true, predictOn: true });
  });

  it('omits the lock param when the reveal is not locked', () => {
    const query = encodeShareState(
      { sql: 'SELECT * FROM users;', policy: 'lru', predictOn: true, step: 0 },
      TABLE,
    );
    expect(query).not.toContain('l=');
    expect(readShareState(query, COLUMNS).lockReveal).toBeUndefined();
  });

  it('names a non-default dataset in the link and reads it back', () => {
    const query = encodeShareState(
      { sql: 'SELECT * FROM orders WHERE id = 1;', policy: 'lru', predictOn: true, step: 0, dataset: 'orders' },
      TABLE,
    );
    expect(query).toContain('t=orders');
    expect(readShareState(query, COLUMNS).dataset).toBe('orders');
    expect(readDatasetParam(query)).toBe('orders');
  });

  it('leaves the default dataset out of the link', () => {
    const query = encodeShareState(
      { sql: 'SELECT * FROM users;', policy: 'lru', predictOn: true, step: 0, dataset: 'users' },
      TABLE,
    );
    expect(query).not.toContain('t=');
    expect(readShareState(query, COLUMNS).dataset).toBeUndefined();
    expect(readDatasetParam(query)).toBe('users');
  });

  it('falls back to users for an unknown dataset id', () => {
    expect(readShareState('t=lineitem', COLUMNS).dataset).toBeUndefined();
    expect(readDatasetParam('t=lineitem')).toBe('users');
  });

  it('carries edited rows, values and types intact', () => {
    const rows = [
      { id: 1, name: 'ada', email: 'ada@example.com', age: 36 },
      { id: 2, name: 'grace', email: null, age: 45 },
    ];
    const query = encodeShareState(
      { sql: 'SELECT * FROM users;', policy: 'lru', predictOn: true, step: 3, rows },
      TABLE,
    );
    expect(readShareState(query, COLUMNS).rows).toEqual(rows);
  });

  describe("a multi-table preset's other tables (plan.md §27.5 S2)", () => {
    const shop = DATASETS.shop.make();
    const others = otherColumnsOf(shop, 'customers');

    it('names every table but the main one, with its columns', () => {
      expect(others).toEqual({ products: ['id', 'name', 'price'], orders: ['id', 'customerId', 'productId', 'qty'] });
    });

    it('carries an edited other table as d.<table>, beside the main table’s d, and reads both back', () => {
      const orders = shop.tables.orders!.rows.filter((r) => r.customerId !== null);
      const customers = shop.tables.customers!.rows.slice(0, 2);
      const query = encodeShareState(
        { sql: 'SELECT * FROM orders;', policy: 'lru', predictOn: false, step: 0, dataset: 'shop', rows: customers, otherRows: { orders } },
        shop.tables.customers,
        shop.tables,
      );
      expect(new URLSearchParams(query).has('d.orders')).toBe(true);
      expect(new URLSearchParams(query).has('d.products')).toBe(false);
      const read = readShareState(query, shop.tables.customers!.columns, others);
      expect(read.rows).toEqual(customers);
      expect(read.otherRows).toEqual({ orders });
      // …and puts them back into the preset, leaving the table nobody edited as it was.
      const restored = presetWithRows(shop, 'customers', read.rows, read.otherRows);
      expect(restored.tables.orders!.rows).toEqual(orders);
      expect(restored.tables.customers!.rows).toEqual(customers);
      expect(restored.tables.products!.rows).toEqual(shop.tables.products!.rows);
    });

    it('ignores a d.<table> for a table the preset does not have, and drops one whose rows do not fit', () => {
      const read = readShareState('d.payments=%5B%5B1%5D%5D&d.orders=%5B%5B1%2C2%5D%5D', shop.tables.customers!.columns, others);
      expect(read.otherRows).toBeUndefined();
    });
  });

  // The URL is the one input this app takes from a stranger: somebody opens a
  // link another person wrote. Every one of these must fall back, not throw.
  describe('a hostile or corrupt link', () => {
    const cases: [string, string][] = [
      ['unparseable rows', 'd=not-json'],
      ['rows that are not an array', 'd=%7B%22a%22%3A1%7D'],
      ['a row with the wrong column count', 'd=%5B%5B1%2C2%5D%5D'],
      ['a row holding an object', 'd=%5B%5B%7B%7D%2C1%2C2%2C3%5D%5D'],
      ['more rows than the cap', `d=${encodeURIComponent(JSON.stringify(Array.from({ length: 501 }, () => [1, 'a', 'b', 2])))}`],
    ];

    for (const [name, query] of cases) {
      it(`drops ${name} rather than half-restoring the table`, () => {
        // A partly-restored dataset would render a trace that is simply a lie.
        expect(readShareState(query, COLUMNS).rows).toBeUndefined();
      });
    }

    it('ignores a policy it does not implement', () => {
      expect(readShareState('p=drop-tables', COLUMNS).policy).toBeUndefined();
    });

    it.each(['lru', 'clock', 'fifo', 'second-chance', 'optimal', 'midpoint', 'lru-k', 'two-q'] as const)(
      'round-trips the %s policy',
      (policy) => {
        const search = encodeShareState({ sql: 'SELECT * FROM users;', policy, predictOn: true, step: 0 }, TABLE);
        expect(readShareState(search, COLUMNS).policy).toBe(policy);
      },
    );

    it.each(['-1', '1e9', 'NaN', '1.5', '999999999'])('ignores step %s', (step) => {
      expect(readShareState(`s=${step}`, COLUMNS).step).toBeUndefined();
    });

    it('ignores an oversized query', () => {
      expect(readShareState(`q=${'x'.repeat(2001)}`, COLUMNS).sql).toBeUndefined();
    });

    it('returns nothing at all for an empty search', () => {
      expect(readShareState('', COLUMNS)).toEqual({});
    });
  });
});

describe('skippedAnswersBefore', () => {
  const events = [
    { id: 0 },
    { id: 1, predictable: {} },
    { id: 2 },
    { id: 3, predictable: {} },
    { id: 4, predictable: {} },
  ];

  it('skips only the prompts before the restored step', () => {
    // Opening a link at step 4 means the questions at 1 and 3 were never put to
    // this reader — leaving their gates armed would freeze playback on a
    // question about something they have not seen.
    expect(skippedAnswersBefore(events, 4)).toEqual({ 1: '', 3: '' });
  });

  it('leaves the prompt at the restored step pending', () => {
    // Step 4 is the moment the link points at, so its question still gets asked.
    expect(skippedAnswersBefore(events, 4)[4]).toBeUndefined();
  });

  it('skips nothing for a link with no step', () => {
    expect(skippedAnswersBefore(events, 0)).toEqual({});
  });
});
