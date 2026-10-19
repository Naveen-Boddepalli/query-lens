import type { DatasetId } from '../engine/index.ts';

/**
 * plan.md §22.7 — the presentation half of the preset dataset library. The
 * `Database` builders are pure and live in `src/engine/datasets.ts`; the label,
 * one-line blurb, opening query and preset *query* chips (§19.2) for each are
 * here, keyed by the same id.
 */

export interface DatasetCatalogueEntry {
  label: string;
  blurb: string;
  starterSql: string;
  presets: { label: string; sql: string }[];
}

/** `shop`'s opening query, and one of its chips: the customers who never ordered (plan.md §27.5 S1, S2). */
const SHOP_NOT_EXISTS = 'SELECT name\nFROM customers\nWHERE NOT EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);';

export const DATASET_CATALOGUE: Record<DatasetId, DatasetCatalogueEntry> = {
  users: {
    label: 'users',
    blurb: '48 rows, indexed on id — the baseline: a 12-page scan against 8 buffer frames.',
    starterSql: 'SELECT *\nFROM users\nWHERE id = 5;',
    presets: [
      { label: 'Point lookup', sql: 'SELECT *\nFROM users\nWHERE id = 5;' },
      { label: 'Sequential scan', sql: 'SELECT *\nFROM users\nWHERE age > 30;' },
      { label: 'Lookup, no index', sql: "SELECT *\nFROM users\nWHERE name = 'grace';" },
      // plan.md §25.4 B6: the plan, and what actually ran, as a result you can read — estimate beside actual.
      { label: 'EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE\nSELECT *\nFROM users\nWHERE age > 30;' },
    ],
  },
  orders: {
    label: 'orders',
    blurb: '120 rows, indexed on id — a deeper B+Tree and a scan that evicts far harder.',
    starterSql: 'SELECT *\nFROM orders\nWHERE id = 42;',
    presets: [
      { label: 'Deep lookup', sql: 'SELECT *\nFROM orders\nWHERE id = 42;' },
      { label: 'Eviction storm', sql: 'SELECT *\nFROM orders\nWHERE total > 500;' },
      { label: 'Scan by customer', sql: "SELECT *\nFROM orders\nWHERE customer = 'acme';" },
    ],
  },
  logins: {
    label: 'logins',
    blurb: '80 rows with an 8:1 skew on status — the same = predicate, wildly different result size.',
    starterSql: "SELECT *\nFROM logins\nWHERE status = 'blocked';",
    presets: [
      { label: 'Selective scan', sql: "SELECT *\nFROM logins\nWHERE status = 'blocked';" },
      { label: 'Unselective scan', sql: "SELECT *\nFROM logins\nWHERE status = 'ok';" },
      { label: 'Point lookup', sql: 'SELECT *\nFROM logins\nWHERE id = 20;' },
    ],
  },
  employees: {
    label: 'employees',
    blurb: '250 rows — department and office are perfectly correlated, so an AND of both badly underestimates.',
    starterSql: "EXPLAIN ANALYZE\nSELECT *\nFROM employees\nWHERE department = 'engineering' AND office = 'building-1';",
    presets: [
      {
        label: 'Correlated AND',
        sql: "EXPLAIN ANALYZE\nSELECT *\nFROM employees\nWHERE department = 'engineering' AND office = 'building-1';",
      },
      { label: 'Department alone', sql: "SELECT *\nFROM employees\nWHERE department = 'engineering';" },
      { label: 'Point lookup', sql: 'SELECT *\nFROM employees\nWHERE id = 42;' },
    ],
  },
  transactions: {
    label: 'transactions',
    blurb: '3,000 rows, indexed on id — a genuinely deep B+Tree and a scan that evicts hard, not just a little.',
    starterSql: 'SELECT *\nFROM transactions\nWHERE id = 1500;',
    presets: [
      { label: 'Deep lookup', sql: 'SELECT *\nFROM transactions\nWHERE id = 1500;' },
      { label: 'Range lookup', sql: 'SELECT *\nFROM transactions\nWHERE id BETWEEN 1500 AND 1520;' },
      { label: 'Eviction storm', sql: 'SELECT *\nFROM transactions\nWHERE amount > 4500;' },
      {
        label: 'EXPLAIN ANALYZE',
        sql: 'EXPLAIN ANALYZE\nSELECT *\nFROM transactions\nWHERE amount > 4500;',
      },
    ],
  },
  // plan.md §26 Feature 3: the preset built around NULLs, so three-valued logic shows without editing any rows.
  customers: {
    label: 'customers',
    blurb: '20 rows, some with no city, no referrer or no discount on record — NULLs, so SQL’s third truth value shows.',
    starterSql: 'SELECT *\nFROM customers\nWHERE city IS NULL;',
    presets: [
      { label: 'IS NULL', sql: 'SELECT *\nFROM customers\nWHERE city IS NULL;' },
      { label: '= NULL finds nothing', sql: 'SELECT *\nFROM customers\nWHERE city = NULL;' },
      { label: 'Aggregates skip NULLs', sql: 'SELECT COUNT(*), COUNT(discount), AVG(discount)\nFROM customers;' },
      { label: 'NOT IN meets a NULL', sql: 'SELECT name\nFROM customers\nWHERE id NOT IN (SELECT referrer FROM customers);' },
      // plan.md §27.5 S7: one table under two names — joined to itself, and read again in its own NOT EXISTS.
      { label: 'Self-join', sql: 'SELECT c.name, r.name\nFROM customers AS c\nLEFT JOIN customers AS r ON c.referrer = r.id;' },
      { label: 'NOT EXISTS, by alias', sql: 'SELECT c.name\nFROM customers AS c\nWHERE NOT EXISTS (SELECT * FROM customers AS r WHERE r.referrer = c.id);' },
    ],
  },
  // plan.md §27.5 S2: the first preset with more than one table — joins and subqueries without the Custom editor.
  shop: {
    label: 'shop',
    blurb: 'Three tables — customers, products and orders — for joins and subqueries. Three customers never order, and two orders are a guest’s, with no customer.',
    starterSql: SHOP_NOT_EXISTS,
    presets: [
      { label: 'JOIN', sql: 'SELECT customers.name, orders.id\nFROM customers\nJOIN orders ON customers.id = orders.customerId;' },
      { label: 'EXISTS', sql: 'SELECT name\nFROM customers\nWHERE EXISTS (SELECT * FROM orders WHERE orders.customerId = customers.id);' },
      { label: 'NOT EXISTS', sql: SHOP_NOT_EXISTS },
      { label: 'NOT IN meets a NULL', sql: 'SELECT name\nFROM customers\nWHERE id NOT IN (SELECT customerId FROM orders);' },
      // plan.md §27.5 S3: the same three customers, by set difference.
      { label: 'EXCEPT', sql: 'SELECT id\nFROM customers\nEXCEPT\nSELECT customerId\nFROM orders;' },
      // plan.md §27.5 S4: every customer and every order, each unmatched row once; then every pair.
      { label: 'FULL JOIN', sql: 'SELECT customers.name, orders.id\nFROM customers\nFULL JOIN orders ON customers.id = orders.customerId;' },
      { label: 'CROSS JOIN', sql: 'SELECT customers.name, products.name\nFROM customers\nCROSS JOIN products;' },
      // plan.md §27.5 S5: nine customers, thirty-eight orders with one, forty orders.
      { label: 'COUNT(DISTINCT)', sql: 'SELECT COUNT(DISTINCT customerId), COUNT(customerId), COUNT(*)\nFROM orders;' },
      // plan.md §27.5 S6: a subquery as a value, run once before planning.
      { label: 'Above average', sql: 'SELECT name, price\nFROM products\nWHERE price > (SELECT AVG(price) FROM products);' },
      {
        label: 'Orders per customer',
        sql: 'SELECT customers.name, COUNT(orders.id)\nFROM customers\nLEFT JOIN orders ON customers.id = orders.customerId\nGROUP BY customers.name\nORDER BY COUNT(orders.id) DESC;',
      },
      {
        label: 'Three tables',
        sql: 'SELECT customers.name, products.name, orders.qty\nFROM orders\nJOIN customers ON orders.customerId = customers.id\nJOIN products ON orders.productId = products.id;',
      },
    ],
  },
};
