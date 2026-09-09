import { describe, expect, it } from 'vitest';
import { createSeedDatabase } from '../../engine/index.ts';
import type { Row } from '../../engine/index.ts';
import {
  parseTraceFile,
  serializeTraceFile,
  TRACE_FILE_KIND,
  TRACE_FILE_VERSION,
} from '../traceFile.ts';
import type { TraceState } from '../traceFile.ts';

const COLUMNS = createSeedDatabase().tables.users!.columns;

const BASE: TraceState = {
  sql: 'SELECT * FROM users WHERE id = 5;',
  policy: 'clock',
  predictOn: false,
  step: 13,
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
});

describe('round-trip', () => {
  it('restores a moment with the seed dataset', () => {
    const parsed = parseTraceFile(serializeTraceFile(BASE), COLUMNS);
    expect(parsed).toEqual({ ok: true, value: BASE });
  });

  it('restores edited rows, values and types intact', () => {
    const rows: Row[] = [
      { id: 1, name: 'ada', email: 'ada@x.dev', age: 36 },
      { id: 2, name: 'bo', email: 'bo@x.dev', age: 41 },
    ];
    const parsed = parseTraceFile(serializeTraceFile({ ...BASE, rows }), COLUMNS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rows).toEqual(rows);
  });
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
    { name: 'rows missing a column', mutate: (o) => (o.rows = [{ id: 1, name: 'ada' }]) },
    {
      name: 'rows with a typo’d extra column',
      mutate: (o) =>
        (o.rows = [{ id: 1, name: 'ada', email: 'a@x', age: 30, xtra: 1 }]),
    },
    { name: 'a row that is not an object', mutate: (o) => (o.rows = ['nope']) },
  ];

  for (const { name, mutate } of cases) {
    it(`rejects the whole file: ${name}`, () => {
      const o = asObject(BASE);
      mutate(o);
      const parsed = parseTraceFile(JSON.stringify(o), COLUMNS);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/\S/);
    });
  }

  it('rejects text that is not JSON', () => {
    expect(parseTraceFile('{ not json', COLUMNS).ok).toBe(false);
  });

  it('rejects a JSON array', () => {
    expect(parseTraceFile('[]', COLUMNS).ok).toBe(false);
  });
});
