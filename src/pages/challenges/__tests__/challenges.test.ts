import { describe, expect, it } from 'vitest';
import { DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../../../engine/index.ts';
import {
  CHALLENGES,
  challengeById,
  challengeDatabase,
  challengeDataset,
  challengeOptions,
  challengeStats,
  optionalClauses,
} from '../challenges.tsx';
import type { Challenge } from '../challenges.tsx';

const runOn = (c: Challenge, sql: string) => runQuery(sql, challengeDatabase(c), challengeOptions(c));

describe('challenges', () => {
  it('has unique ids', () => {
    const ids = CHALLENGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every starter query parses and does NOT already pass', () => {
    for (const c of CHALLENGES) {
      const r = runOn(c, c.starter);
      expect(r.error, `${c.id} starter errored: ${r.error?.message ?? ''}`).toBeUndefined();
      expect(c.check(r, c.starter), `${c.id} starter should not pass`).toBe(false);
    }
  });

  // One known solution per challenge — the check must accept it.
  const solutions: Record<string, string> = {
    'use-the-index': 'SELECT * FROM users WHERE id = 5;',
    'eviction-storm': 'SELECT * FROM users WHERE age > 10;',
    'exactly-one': 'SELECT * FROM users WHERE id = 5;',
    'empty-but-not-free': 'SELECT * FROM users WHERE age > 200;',
    'and-that-matches': "SELECT * FROM users WHERE id = 5 AND age > 0;",
    'push-it-down': 'SELECT * FROM users WHERE age > 30;',
    'deep-descent': 'SELECT * FROM orders WHERE id = 42;',
    'needle-in-the-skew': "SELECT * FROM logins WHERE status = 'blocked';",
    'sort-spill': 'SELECT * FROM users ORDER BY age;',
    'hash-beats-loop': 'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId;',
    'dirty-eviction': "UPDATE users SET name = 'edited' WHERE age > 30;",
    'range-leap': 'SELECT * FROM users WHERE id > 44;',
    'the-index-it-cannot-serve': 'SELECT * FROM users WHERE id <> 5;',
    'wrap-the-column': 'SELECT * FROM users WHERE id + 0 = 5;',
    'equals-null': 'SELECT * FROM contacts WHERE email IS NULL;',
    'count-the-nulls': 'SELECT COUNT(*), COUNT(email) FROM contacts;',
    'not-in-the-null': 'SELECT * FROM people WHERE id NOT IN (SELECT person_id FROM banned);',
    'never-ordered': 'SELECT name FROM customers WHERE NOT EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);',
    'nobody-ordered-it': 'SELECT id FROM products EXCEPT SELECT productId FROM orders;',
    'leave-no-one-out': 'SELECT customers.name, orders.id FROM customers FULL JOIN orders ON customers.id = orders.customerId;',
    'count-each-once': 'SELECT COUNT(DISTINCT customerId) FROM orders;',
    'above-average': 'SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products);',
    'not-paris-either': "SELECT * FROM customers WHERE city <> 'Paris' OR city IS NULL;",
    'keep-the-unmatched':
      'SELECT authors.name, posts.title FROM authors LEFT JOIN posts ON authors.id = posts.authorId WHERE posts.title IS NULL;',
    'and-before-or': 'SELECT * FROM users WHERE (id = 1 OR id = 3 OR id = 4) AND age > 30;',
    'every-clause':
      'SELECT DISTINCT age, COUNT(*) FROM users WHERE age > 20 GROUP BY age HAVING COUNT(*) >= 1 ORDER BY age LIMIT 5 OFFSET 1;',
  };

  it('has a solution wired for every challenge', () => {
    expect(Object.keys(solutions).sort()).toEqual(CHALLENGES.map((c) => c.id).sort());
  });

  it('accepts a known solution', () => {
    for (const c of CHALLENGES) {
      const sql = solutions[c.id];
      expect(sql, `no solution wired for ${c.id}`).toBeTruthy();
      const r = runOn(c, sql!);
      expect(r.error).toBeUndefined();
      expect(c.check(r, sql!), `${c.id} rejected its solution`).toBe(true);
    }
  });

  it('challengeById round-trips', () => {
    for (const c of CHALLENGES) expect(challengeById(c.id)).toBe(c);
    expect(challengeById('nope')).toBeUndefined();
  });

  it('challengeStats reports the numbers the page shows', () => {
    const s = challengeStats(
      runQuery('SELECT * FROM users WHERE id = 5;', DATASETS.users.make(), DEFAULT_ENGINE_OPTIONS),
    );
    expect(s.rows).toBe(1);
    expect(s.usesIndex).toBe(true);
    expect(s.diskReads).toBeGreaterThanOrEqual(0);
    expect(s.evictions).toBe(0);
    expect(s.writes).toBe(0);
    expect(s.dirtyEvictions).toBe(0);
    expect(s.usesRangeScan).toBe(false);
  });

  it('challenges name only real datasets, when they use a dataset at all', () => {
    for (const c of CHALLENGES) {
      if (c.database) continue; // its own one-off database, not a DatasetId
      expect(DATASETS[challengeDataset(c)], `${c.id} names an unknown dataset`).toBeTruthy();
    }
  });

  describe('the misconception challenges reject their nearby cheats', () => {
    const cheats: [string, string][] = [
      ['the-index-it-cannot-serve', 'SELECT * FROM users WHERE age <> 5;'],
      ['wrap-the-column', 'SELECT * FROM users WHERE age + 0 = 5;'],
      ['equals-null', 'SELECT * FROM contacts WHERE id = 2;'],
      ['count-the-nulls', 'SELECT COUNT(*), COUNT(id) FROM contacts;'],
      ['not-in-the-null', 'SELECT * FROM people WHERE id NOT IN (SELECT person_id FROM banned WHERE person_id IS NOT NULL) AND id > 9;'],
      // Each loses the five customers with no city, or keeps Paris, or is the wrong slice.
      ['not-paris-either', "SELECT * FROM customers WHERE city <> 'Paris';"],
      // The three who never ordered, and nobody else: not everyone, not those who did, not two of the three.
      ['never-ordered', 'SELECT name FROM customers;'],
      ['never-ordered', 'SELECT name FROM customers WHERE EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);'],
      ['never-ordered', 'SELECT name FROM customers WHERE NOT EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id) AND id < 12;'],
      ['never-ordered', 'SELECT city FROM customers WHERE NOT EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);'],
      // The vase, but by a subquery; a set operator, but the wrong rows; or the right operator the wrong way round.
      ['nobody-ordered-it', 'SELECT id FROM products WHERE id NOT IN (SELECT productId FROM orders);'],
      ['nobody-ordered-it', 'SELECT id FROM products INTERSECT SELECT productId FROM orders;'],
      ['nobody-ordered-it', 'SELECT productId FROM orders EXCEPT SELECT id FROM products;'],
      ['nobody-ordered-it', 'SELECT id, name FROM products EXCEPT SELECT id, name FROM products WHERE id < 8;'],
      // One side kept but not the other, neither, every pair, both stacked with their matches twice, or the padding filtered away.
      ['leave-no-one-out', 'SELECT customers.name, orders.id FROM customers LEFT JOIN orders ON customers.id = orders.customerId;'],
      ['leave-no-one-out', 'SELECT customers.name, orders.id FROM customers RIGHT JOIN orders ON customers.id = orders.customerId;'],
      ['leave-no-one-out', 'SELECT customers.name, orders.id FROM customers JOIN orders ON customers.id = orders.customerId;'],
      ['leave-no-one-out', 'SELECT customers.name, orders.id FROM customers CROSS JOIN orders;'],
      [
        'leave-no-one-out',
        'SELECT customers.name, orders.id FROM customers LEFT JOIN orders ON customers.id = orders.customerId UNION ALL SELECT customers.name, orders.id FROM customers RIGHT JOIN orders ON customers.id = orders.customerId;',
      ],
      ['leave-no-one-out', 'SELECT customers.name, orders.id FROM customers FULL JOIN orders ON customers.id = orders.customerId WHERE orders.id IS NOT NULL;'],
      ['leave-no-one-out', 'SELECT customers.name FROM customers FULL JOIN orders ON customers.id = orders.customerId;'],
      // Every order, every order with a customer, the right rows uncounted, another column, or nine without DISTINCT.
      ['count-each-once', 'SELECT COUNT(*) FROM orders;'],
      ['count-each-once', 'SELECT COUNT(customerId) FROM orders;'],
      ['count-each-once', 'SELECT DISTINCT customerId FROM orders;'],
      ['count-each-once', 'SELECT COUNT(DISTINCT productId) FROM orders;'],
      ['count-each-once', 'SELECT COUNT(DISTINCT customerId), COUNT(*) FROM orders;'],
      ['count-each-once', 'SELECT COUNT(*) FROM customers WHERE EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);'],
      // The average typed in, a different statistic, every product, or the wrong side of it.
      ['above-average', 'SELECT name FROM products WHERE price > 84.625;'],
      ['above-average', 'SELECT name FROM products WHERE price > (SELECT MIN(price) FROM products);'],
      ['above-average', 'SELECT name FROM products;'],
      ['above-average', 'SELECT name FROM products WHERE price < (SELECT AVG(price) FROM products);'],
      ['not-paris-either', "SELECT * FROM customers WHERE NOT (city = 'Paris');"],
      ['not-paris-either', "SELECT * FROM customers WHERE city NOT IN ('Paris');"],
      ['not-paris-either', 'SELECT * FROM customers WHERE city IS NULL;'],
      ['not-paris-either', 'SELECT * FROM customers;'],
      ['not-paris-either', 'SELECT city FROM customers WHERE city <> \'Paris\' OR city IS NULL;'],
      ['keep-the-unmatched', 'SELECT authors.name, posts.title FROM authors LEFT JOIN posts ON authors.id = posts.authorId WHERE posts.id = 999;'],
      // The right two people, but not by way of an OR under an AND.
      ['and-before-or', 'SELECT * FROM users WHERE id IN (3, 4) AND age > 30;'],
      ['and-before-or', 'SELECT * FROM users WHERE id = 3 OR id = 4;'],
      // Both operators, and the wrong people.
      ['and-before-or', 'SELECT * FROM users WHERE (id = 1 OR id = 3) AND age > 20;'],
      ['and-before-or', 'SELECT * FROM users WHERE (id = 3 OR id = 4 OR id = 5) AND age > 30;'],
      ['and-before-or', 'SELECT * FROM users WHERE (id = 3 OR id = 5) AND age > 30;'],
      // Six of the seven that run together, each time a different one missing (OFFSET cannot stand without a LIMIT).
      ['every-clause', 'SELECT DISTINCT age, COUNT(*) FROM users WHERE age > 20 GROUP BY age HAVING COUNT(*) >= 1 ORDER BY age LIMIT 5;'],
      ['every-clause', 'SELECT age, COUNT(*) FROM users WHERE age > 20 GROUP BY age HAVING COUNT(*) >= 1 ORDER BY age LIMIT 5 OFFSET 1;'],
      ['every-clause', 'SELECT DISTINCT age, COUNT(*) FROM users GROUP BY age HAVING COUNT(*) >= 1 ORDER BY age LIMIT 5 OFFSET 1;'],
      ['every-clause', 'SELECT DISTINCT age, COUNT(*) FROM users WHERE age > 20 GROUP BY age ORDER BY age LIMIT 5 OFFSET 1;'],
      ['every-clause', 'SELECT DISTINCT age, COUNT(*) FROM users WHERE age > 20 GROUP BY age HAVING COUNT(*) >= 1 LIMIT 5 OFFSET 1;'],
      ['every-clause', 'SELECT DISTINCT age FROM users WHERE age > 20 ORDER BY age LIMIT 5 OFFSET 1;'],
    ];
    for (const [id, sql] of cheats) {
      it(`${id} rejects: ${sql}`, () => {
        const c = challengeById(id)!;
        const r = runOn(c, sql);
        expect(r.error).toBeUndefined();
        expect(c.check(r, sql)).toBe(false);
      });
    }
  });

  it('nobody-ordered-it accepts the vase by its id or its name (plan.md §27.5 S3)', () => {
    const c = challengeById('nobody-ordered-it')!;
    for (const sql of [
      'SELECT name FROM products EXCEPT SELECT products.name FROM products JOIN orders ON products.id = orders.productId;',
      'SELECT id FROM products EXCEPT SELECT productId FROM orders ORDER BY id;',
    ]) {
      const r = runOn(c, sql);
      expect(r.error, sql).toBeUndefined();
      expect(c.check(r, sql), sql).toBe(true);
    }
  });

  it('leave-no-one-out accepts the full join either way round, and a LEFT and a RIGHT joined by UNION (plan.md §27.5 S4)', () => {
    const c = challengeById('leave-no-one-out')!;
    for (const sql of [
      'SELECT orders.id, customers.name FROM orders FULL OUTER JOIN customers ON orders.customerId = customers.id;',
      'SELECT customers.name, orders.id FROM customers FULL JOIN orders ON %s ORDER BY orders.id DESC;',
      'SELECT customers.name, orders.id FROM customers LEFT JOIN orders ON %s UNION SELECT customers.name, orders.id FROM customers RIGHT JOIN orders ON %s;',
      'SELECT * FROM customers FULL JOIN orders ON %s;',
    ]) {
      const r = runOn(c, sql.replaceAll('%s', 'customers.id = orders.customerId'));
      expect(r.error, sql).toBeUndefined();
      expect(c.check(r, sql), sql).toBe(true);
    }
    // The stacked version the misconception describes: every matched pair twice.
    const stacked = runOn(c, `SELECT customers.name, orders.id FROM customers LEFT JOIN orders ON ${'customers.id = orders.customerId'} UNION ALL SELECT customers.name, orders.id FROM customers RIGHT JOIN orders ON customers.id = orders.customerId;`);
    expect(stacked.rows).toHaveLength(38 * 2 + 3 + 2);
  });

  it('count-each-once accepts a NULL filter, a LIMIT, and either aggregate strategy (plan.md §27.5 S5)', () => {
    const c = challengeById('count-each-once')!;
    for (const [sql, options] of [
      ['SELECT COUNT(DISTINCT customerId) FROM orders LIMIT 1;', challengeOptions(c)],
      ['SELECT COUNT(DISTINCT customerId) FROM orders WHERE customerId IS NOT NULL;', challengeOptions(c)],
      ['SELECT COUNT(DISTINCT customerId) FROM orders;', { ...challengeOptions(c), aggregateStrategy: 'sort' as const }],
    ] as const) {
      const r = runQuery(sql, challengeDatabase(c), options);
      expect(r.error, sql).toBeUndefined();
      expect(c.check(r, sql), sql).toBe(true);
    }
    // The misconception's numbers: ten distinct rows, NULL among them; nine distinct values.
    expect(runOn(c, 'SELECT DISTINCT customerId FROM orders;').rows).toHaveLength(10);
  });

  it('above-average accepts the subquery on either side, more columns, and an order; WHERE … AVG is refused (plan.md §27.5 S6)', () => {
    const c = challengeById('above-average')!;
    for (const sql of [
      'SELECT name, price FROM products WHERE (SELECT AVG(price) FROM products) < price ORDER BY price DESC;',
      'SELECT name FROM products WHERE price > (SELECT SUM(price) FROM products) / (SELECT COUNT(*) FROM products);',
    ]) {
      const r = runOn(c, sql);
      expect(r.error, sql).toBeUndefined();
      expect(c.check(r, sql), sql).toBe(true);
    }
    // The misconception: an aggregate has nothing to read in WHERE.
    expect(runOn(c, 'SELECT name FROM products WHERE price > AVG(price);').error?.message).toMatch(/cannot be used here/);
  });

  it('never-ordered accepts every honest way of asking (plan.md §27.5 S1)', () => {
    const c = challengeById('never-ordered')!;
    for (const sql of [
      'SELECT id FROM customers WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.customerId = customers.id);',
      'SELECT name FROM customers WHERE id NOT IN (SELECT customerId FROM orders WHERE customerId IS NOT NULL);',
      'SELECT customers.name FROM customers LEFT JOIN orders ON customers.id = orders.customerId WHERE orders.id IS NULL;',
    ]) {
      const r = runOn(c, sql);
      expect(r.error, sql).toBeUndefined();
      expect(c.check(r, sql), sql).toBe(true);
    }
  });

  describe('the challenges about how a query is read', () => {
    const solved = (id: string, sql: string) => {
      const c = challengeById(id)!;
      const r = runOn(c, sql);
      return r.error === undefined && c.check(r, sql);
    };

    it('not-paris-either takes the right customers however the query finds them, by id or by name', () => {
      expect(solved('not-paris-either', "SELECT id FROM customers WHERE id NOT IN (SELECT id FROM customers WHERE city = 'Paris');")).toBe(true);
      expect(solved('not-paris-either', "SELECT name FROM customers WHERE city IS NULL OR city <> 'Paris';")).toBe(true);
    });

    it('and-before-or takes the two people however the query names them, and any grouping that gets them', () => {
      expect(solved('and-before-or', 'SELECT name FROM users WHERE (id = 3 OR id = 4) AND age > 30;')).toBe(true);
      expect(solved('and-before-or', 'SELECT id FROM users WHERE id = 3 AND age > 30 OR id = 4 AND age > 30;')).toBe(true);
    });

    it('every-clause has one table, so a JOIN cannot be the way to more clauses — it is refused, and never passes', () => {
      const c = challengeById('every-clause')!;
      for (const sql of [
        'SELECT DISTINCT age FROM users JOIN orders ON users.id = orders.user_id WHERE age > 20 ORDER BY age LIMIT 5 OFFSET 1;',
      ]) {
        const r = runOn(c, sql);
        expect(r.error, sql).toBeDefined();
        expect(c.check(r, sql), sql).toBe(false);
      }
    });

    it('counts the optional parts the parse tree shows', () => {
      const count = (sql: string) => optionalClauses(runQuery(sql, DATASETS.users.make(), DEFAULT_ENGINE_OPTIONS).events);
      expect(count('SELECT * FROM users')).toBe(0);
      expect(count('SELECT DISTINCT age FROM users')).toBe(1);
      expect(count('SELECT * FROM users WHERE age > 20 LIMIT 5')).toBe(2);
      expect(count('SELECT * FROM users WHERE age > 20 LIMIT 5 OFFSET 1')).toBe(3);
      expect(count('SELECT DISTINCT age FROM users WHERE age > 20 ORDER BY age LIMIT 5 OFFSET 1')).toBe(5);
      expect(count(solutions['every-clause']!)).toBe(7);
    });

    it('opens the tool on what was written, and leaves the link out when the tool cannot take it', () => {
      const parser = challengeById('and-before-or')!.tool!;
      const sql = "SELECT * FROM users WHERE name = 'a b' AND id = 1";
      const url = new URL(parser.href(sql)!, 'https://x');
      expect(url.pathname).toBe('/tools/parser');
      expect(url.searchParams.get('src')).toBe(sql);
      expect(parser.href('   ')).toBeNull();
      expect(parser.href('x'.repeat(2000))).not.toBeNull();
      expect(parser.href('x'.repeat(2001))).toBeNull();
      expect(challengeById('every-clause')!.tool!.href('anything')).toBe('/tools/grammar#rule-select');
    });
  });

  describe('a challenge with its own database (hash-beats-loop)', () => {
    const c = CHALLENGES.find((ch) => ch.id === 'hash-beats-loop')!;

    it('runs against the authors/posts JOIN demo, not the default users dataset', () => {
      const r = runOn(c, 'SELECT * FROM authors;');
      expect(r.error).toBeUndefined();
      expect(r.rows.length).toBeGreaterThan(0);
    });

    it('runs under its own forced bufferFrames: 2, not the default 8', () => {
      expect(challengeOptions(c).bufferFrames).toBe(2);
    });

    it('rejects a query with no real JOIN — nested-loop and hash cost the same for one table', () => {
      const r = runOn(c, 'SELECT * FROM authors;');
      expect(c.check(r, 'SELECT * FROM authors;')).toBe(false);
    });
  });

  describe('the sort-spill and dirty-eviction thresholds', () => {
    const sortSpill = CHALLENGES.find((c) => c.id === 'sort-spill')!;
    const dirtyEviction = CHALLENGES.find((c) => c.id === 'dirty-eviction')!;

    it('a tiny ORDER BY writes only one run — not enough to pass', () => {
      const r = runOn(sortSpill, 'SELECT * FROM users WHERE id = 5 ORDER BY age;');
      expect(sortSpill.check(r, 'SELECT * FROM users WHERE id = 5 ORDER BY age;')).toBe(false);
    });

    it('a single-row UPDATE never forces an eviction — not enough to pass', () => {
      const sql = "UPDATE users SET name = 'x' WHERE id = 5;";
      const r = runOn(dirtyEviction, sql);
      expect(dirtyEviction.check(r, sql)).toBe(false);
    });
  });
});
