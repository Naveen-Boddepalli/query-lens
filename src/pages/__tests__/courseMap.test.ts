import { describe, expect, it } from 'vitest';
import { CHALLENGES } from '../challenges/challenges.tsx';
import { SCRIPT_CHALLENGES } from '../challenges/scriptChallenges.tsx';
import { SETTINGS_CHALLENGES } from '../challenges/settingsChallenges.tsx';
import { LESSONS } from '../learn/lessons.tsx';
import { DATASETS } from '../../engine/datasets.ts';
import { runQuery } from '../../engine/runQuery.ts';
import appSource from '../../App.tsx?raw';

/**
 * plan.md §28.5 U2: the course map is the page a student reads to decide what to trust, and it drifted — rows
 * listed outer joins, join order and clustered tables as missing long after they were built, and nothing failed.
 * This holds the half of it a test can check: every link resolves to a page, lesson, challenge or heading that
 * exists, every construct the SQL row claims runs, and every one its "What is missing" cell names is still
 * refused — so building one fails here until the row is updated.
 */

/** Every docs page's source, by path under `DocsContent/`, without its extension. */
const DOCS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../DocsContent/**/*.mdx', { query: '?raw', import: 'default', eager: true }),
  ).map(([path, source]) => [path.replace('../DocsContent/', '').replace(/\.mdx$/, ''), source]),
);
const MAP = DOCS['study/course-map'] ?? '';

// ---------------------------------------------------------------------------------------------------- links

const keysOf = (table: string) => {
  const start = appSource.indexOf(`const ${table}:`);
  const body = appSource.slice(start, appSource.indexOf('\n};', start));
  // Quoted where the key needs it (`'2pc'`, `'study/course-map'`), bare where it does not (`lsm`, `compare`).
  return [...body.matchAll(/^ {2}'?([a-z0-9/-]+)'?:/gm)].map((m) => m[1]!);
};

const PAGES = new Set([
  '/',
  ...[...appSource.matchAll(/<Route path="([a-z-]+)"/g)].map((m) => `/${m[1]!}`),
  ...keysOf('PAGES').map((k) => `/${k}`),
  ...keysOf('TOOL_PAGES').map((k) => `/tools/${k}`),
  ...keysOf('DOC_PAGES').map((k) => `/docs/${k}`),
  ...LESSONS.map((l) => `/learn/${l.id}`),
  ...[...CHALLENGES, ...SCRIPT_CHALLENGES, ...SETTINGS_CHALLENGES].map((c) => `/challenges/${c.id}`),
]);

/** github-slugger's rule, which `rehype-slug` applies to every docs heading, for the headings these pages have. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

const headingsOf = (mdx: string) => new Set([...mdx.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));

const docSource = (path: string) => DOCS[path.replace(/^\/docs\//, '')] ?? '';

const LINKS = [...MAP.matchAll(/\]\((\/[^)\s]*)\)/g), ...MAP.matchAll(/href: '(#[^']+)'/g)].map((m) => m[1]!);

describe('the course map’s links', () => {
  it('are found by the pattern this test reads the page with', () => {
    expect(LINKS.length).toBeGreaterThan(60);
    expect(PAGES.size).toBeGreaterThan(100);
  });

  for (const href of new Set(LINKS)) {
    it(`${href} resolves`, () => {
      const url = new URL(href, 'https://x/docs/study/course-map');
      expect(PAGES.has(url.pathname), `no page at ${url.pathname}`).toBe(true);
      if (!url.hash) return;
      expect(url.pathname.startsWith('/docs/'), `${href}: only a docs page has heading anchors`).toBe(true);
      const target = url.pathname === '/docs/study/course-map' ? MAP : docSource(url.pathname);
      expect(headingsOf(target).has(url.hash.slice(1)), `no heading ${url.hash} on ${url.pathname}`).toBe(true);
    });
  }
});

// ------------------------------------------------------------------------------------------------------ SQL

const sqlRow = MAP.split('\n').find((line: string) => line.startsWith('| SQL |'));
const cells = sqlRow?.split(' | ') ?? [];
const claimed = cells[2] ?? '';
const missing = (cells[3] ?? '').replace(/\s*\|\s*$/, '');

const shop = () => DATASETS.shop.make();

/** One statement per construct the row's *Where to practise* cell claims, on the three-table `shop` preset. */
const CLAIMS: Record<string, string[]> = {
  '`WHERE` with `AND`/`OR`/`NOT`/`IN`/`LIKE`/`IS NULL`, arithmetic': [
    "SELECT name, id * 2 FROM customers WHERE (city = 'Paris' OR NOT id = 3) AND name LIKE '%a%' AND city IS NOT NULL AND id IN (1, 2, 3, 4, 5)",
  ],
  '`GROUP BY`/`HAVING` with `COUNT(DISTINCT …)`': [
    'SELECT city, COUNT(DISTINCT name) FROM customers GROUP BY city HAVING COUNT(*) > 0',
  ],
  '`DISTINCT`': ['SELECT DISTINCT city FROM customers'],
  '`ORDER BY`/`LIMIT`/`OFFSET`': ['SELECT name FROM customers ORDER BY name LIMIT 3 OFFSET 1'],
  'chains of `JOIN`': [
    'SELECT customers.name, products.name FROM customers JOIN orders ON orders.customerId = customers.id JOIN products ON products.id = orders.productId',
  ],
  '`LEFT` / `RIGHT` / `FULL [OUTER] JOIN`': [
    'SELECT customers.name, orders.id FROM customers LEFT JOIN orders ON orders.customerId = customers.id',
    'SELECT customers.name, orders.id FROM customers RIGHT JOIN orders ON orders.customerId = customers.id',
    'SELECT customers.name, orders.id FROM customers FULL OUTER JOIN orders ON orders.customerId = customers.id',
  ],
  '`CROSS JOIN` or `FROM a, b`': [
    'SELECT customers.id, products.id FROM customers CROSS JOIN products',
    'SELECT customers.id, products.id FROM customers, products',
  ],
  'an uncorrelated `IN (subquery)`': ['SELECT name FROM customers WHERE id IN (SELECT customerId FROM orders)'],
  '`UNION [ALL]` / `INTERSECT` / `EXCEPT`': [
    'SELECT city FROM customers UNION ALL SELECT name FROM products',
    'SELECT id FROM customers INTERSECT SELECT customerId FROM orders',
    'SELECT id FROM customers EXCEPT SELECT customerId FROM orders',
  ],
  'a correlated `[NOT] EXISTS`': [
    'SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT * FROM orders o WHERE o.customerId = c.id)',
  ],
  'a scalar subquery used as a value': ['SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)'],
  'table aliases and self-joins': ['SELECT a.name, b.name FROM customers a JOIN customers b ON a.city = b.city'],
  '`INSERT`/`UPDATE`/`DELETE`': [
    "INSERT INTO customers (id, name, city) VALUES (99, 'Zed', 'Oslo')",
    "UPDATE customers SET city = 'Rome' WHERE id = 1",
    'DELETE FROM orders WHERE qty > 100',
  ],
  '`EXPLAIN [ANALYZE]`': ['EXPLAIN SELECT * FROM customers WHERE id = 1', 'EXPLAIN ANALYZE SELECT * FROM customers WHERE id = 1'],
};

/** One statement per item of the row's *What is missing* cell — each must still be refused. */
const MISSING: Record<string, string[]> = {
  'Correlated subqueries outside `EXISTS`': [
    'SELECT c.name, (SELECT COUNT(*) FROM orders o WHERE o.customerId = c.id) FROM customers c',
    'SELECT c.name FROM customers c WHERE c.id IN (SELECT o.customerId FROM orders o WHERE o.qty > c.id)',
  ],
  'subqueries in `FROM`': ['SELECT * FROM (SELECT id FROM customers) AS c'],
  'window functions': ['SELECT name, ROW_NUMBER() OVER (ORDER BY id) FROM customers'],
  CTEs: ['WITH big AS (SELECT * FROM orders WHERE qty > 1) SELECT * FROM big'],
  DDL: ['CREATE TABLE t (id INT)', 'DROP TABLE orders'],
};

describe('the course map’s SQL row', () => {
  it('is found, with its practise and missing cells', () => {
    expect(claimed).toContain('INSERT');
    expect(missing.length).toBeGreaterThan(0);
  });

  for (const [phrase, statements] of Object.entries(CLAIMS)) {
    it(`claims ${phrase}, and it runs`, () => {
      expect(claimed, `the row no longer says ${phrase}: update CLAIMS with it`).toContain(phrase);
      for (const sql of statements) expect(runQuery(sql, shop()).error, sql).toBeUndefined();
    });
  }

  it('names nothing missing that this test has no statement for', () => {
    expect(missing.split(', ').sort()).toEqual(Object.keys(MISSING).sort());
  });

  for (const [item, statements] of Object.entries(MISSING)) {
    it(`lists ${item} as missing, and it is still refused`, () => {
      for (const sql of statements) {
        expect(runQuery(sql, shop()).error, `${sql} now runs: move it out of the SQL row's missing cell`).toBeDefined();
      }
    });
  }
});
