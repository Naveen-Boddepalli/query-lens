import { describe, expect, it } from 'vitest';
import { DATASETS } from '../../engine/index.ts';
import type { Row } from '../../engine/index.ts';
import {
  parseTraceFile,
  serializeTraceFile,
  TRACE_FILE_KIND,
  TRACE_FILE_VERSION,
} from '../traceFile.ts';
import type { TraceState } from '../traceFile.ts';

const BASE: TraceState = {
  sql: 'SELECT * FROM users WHERE id = 5;',
  policy: 'clock',
  predictOn: false,
  step: 13,
  dataset: 'users',
  rows: null,
};

/** `serializeTraceFile` output, re-parsed as a plain object for field pokes. */
function asObject(state: TraceState): Record<string, unknown> {
  return JSON.parse(serializeTraceFile(state)) as Record<string, unknown>;
}

describe('serializeTraceFile', () => {
  it('stamps the kind, version and a build/export meta block', () => {
    const o = asObject(BASE);
    expect(o.kind).toBe(TRACE_FILE_KIND);
    expect(o.version).toBe(TRACE_FILE_VERSION);
    const meta = o.meta as Record<string, unknown>;
    expect(meta.app).toBe('QueryLens');
    expect(typeof meta.build).toBe('string');
    expect(typeof meta.exportedAt).toBe('string');
    expect(() => new Date(meta.exportedAt as string).toISOString()).not.toThrow();
  });

  it('ends with a trailing newline and is pretty-printed', () => {
    const text = serializeTraceFile(BASE);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "sql":');
  });

  it('omits the dataset field for the default, so a users file reads like a v1 one', () => {
    expect(asObject(BASE)).not.toHaveProperty('dataset');
  });

  it('writes the dataset field for a non-default preset', () => {
    expect(asObject({ ...BASE, dataset: 'orders' }).dataset).toBe('orders');
  });
});

describe('round-trip', () => {
  it('restores a moment with the seed dataset', () => {
    const parsed = parseTraceFile(serializeTraceFile(BASE));
    expect(parsed).toEqual({ ok: true, value: BASE });
  });

  it('restores edited rows, values and types intact', () => {
    const rows: Row[] = [
      { id: 1, name: 'ada', email: 'ada@x.dev', age: 36 },
      { id: 2, name: 'bo', email: 'bo@x.dev', age: 41 },
    ];
    const parsed = parseTraceFile(serializeTraceFile({ ...BASE, rows }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rows).toEqual(rows);
  });

  it('restores a non-default dataset with its own edited rows', () => {
    const rows = DATASETS.orders.make().tables.orders!.rows.slice(0, 3);
    const parsed = parseTraceFile(
      serializeTraceFile({ ...BASE, sql: 'SELECT * FROM orders WHERE id = 1;', dataset: 'orders', rows }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.dataset).toBe('orders');
      expect(parsed.value.rows).toEqual(rows);
    }
  });

  it("restores a multi-table preset's other edited tables, and writes the field only when one was edited (plan.md §27.5 S2)", () => {
    const orders = DATASETS.shop.make().tables.orders!.rows.slice(0, 5);
    const shop: TraceState = { ...BASE, sql: 'SELECT * FROM orders;', dataset: 'shop', rows: null, otherRows: { orders } };
    const parsed = parseTraceFile(serializeTraceFile(shop));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rows).toBeNull();
      expect(parsed.value.otherRows).toEqual({ orders });
    }
    expect(asObject({ ...shop, otherRows: {} })).not.toHaveProperty('otherRows');
  });

  it("refuses other rows for a table the preset does not have, or for its main table, or that do not fit", () => {
    const base = { ...asObject({ ...BASE, dataset: 'shop' }) };
    for (const otherRows of [{ payments: [] }, { customers: [] }, { orders: [{ id: 1 }] }, []]) {
      expect(parseTraceFile(JSON.stringify({ ...base, otherRows })).ok, JSON.stringify(otherRows)).toBe(false);
    }
  });

  it('a v1 file (no dataset field) restores as users', () => {
    const o = asObject(BASE);
    expect(o).not.toHaveProperty('dataset');
    const parsed = parseTraceFile(JSON.stringify(o));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.dataset).toBe('users');
  });
});

describe('every policy', () => {
  it.each(['lru', 'clock', 'fifo', 'second-chance', 'optimal', 'midpoint', 'lru-k', 'two-q'] as const)(
    'a trace run under %s loads back with it',
    (policy) => {
      const parsed = parseTraceFile(serializeTraceFile({ ...BASE, policy }));
      expect(parsed.ok && parsed.value.policy).toBe(policy);
    },
  );
});

describe('a hand-edited or hostile file', () => {
  const cases: { name: string; mutate: (o: Record<string, unknown>) => void }[] = [
    { name: 'not our kind', mutate: (o) => (o.kind = 'something/else') },
    { name: 'a future version', mutate: (o) => (o.version = 2) },
    { name: 'no sql', mutate: (o) => delete o.sql },
    { name: 'an oversized query', mutate: (o) => (o.sql = 'x'.repeat(3000)) },
    { name: 'a policy we do not implement', mutate: (o) => (o.policy = 'mru') },
    { name: 'a non-boolean predictOn', mutate: (o) => (o.predictOn = 'yes') },
    { name: 'a fractional step', mutate: (o) => (o.step = 4.5) },
    { name: 'a negative step', mutate: (o) => (o.step = -1) },
    { name: 'an unknown dataset', mutate: (o) => (o.dataset = 'lineitem') },
    { name: 'rows missing a column', mutate: (o) => (o.rows = [{ id: 1, name: 'ada' }]) },
    {
      name: 'rows with a typo’d extra column',
      mutate: (o) =>
        (o.rows = [{ id: 1, name: 'ada', email: 'a@x', age: 30, xtra: 1 }]),
    },
    { name: 'a row that is not an object', mutate: (o) => (o.rows = ['nope']) },
    {
      name: 'rows shaped for a different dataset',
      mutate: (o) => {
        o.dataset = 'orders';
        o.sql = 'SELECT * FROM orders WHERE id = 1;';
        o.rows = [{ id: 1, name: 'ada', email: 'a@x', age: 30 }];
      },
    },
  ];

  for (const { name, mutate } of cases) {
    it(`rejects the whole file: ${name}`, () => {
      const o = asObject(BASE);
      mutate(o);
      const parsed = parseTraceFile(JSON.stringify(o));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/\S/);
    });
  }

  it('rejects text that is not JSON', () => {
    expect(parseTraceFile('{ not json').ok).toBe(false);
  });

  it('rejects a JSON array', () => {
    expect(parseTraceFile('[]').ok).toBe(false);
  });
});
