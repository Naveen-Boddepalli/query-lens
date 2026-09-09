import { describe, expect, it } from 'vitest';
import { createSeedDatabase } from '../../engine/index.ts';
import { parseSeedCsv } from '../parseCsv.ts';

const users = createSeedDatabase().tables.users!;

describe('parseSeedCsv', () => {
  it('reads plain rows, coercing per column type', () => {
    const out = parseSeedCsv('1,ada,ada@x.dev,36\n2,bo,bo@x.dev,41', users);
    expect(out).toEqual({
      ok: true,
      rows: [
        { id: 1, name: 'ada', email: 'ada@x.dev', age: 36 },
        { id: 2, name: 'bo', email: 'bo@x.dev', age: 41 },
      ],
    });
  });

  it('skips a leading header row that names the columns', () => {
    const out = parseSeedCsv('id,name,email,age\n1,ada,ada@x.dev,36', users);
    expect(out.ok && out.rows).toHaveLength(1);
    expect(out.ok && out.rows[0]).toEqual({ id: 1, name: 'ada', email: 'ada@x.dev', age: 36 });
  });

  it('honours quotes, embedded commas and doubled quotes', () => {
    const out = parseSeedCsv('1,"last, first","a@x.dev",30\n2,"say ""hi""",b@x.dev,31', users);
    expect(out.ok && out.rows[0]!.name).toBe('last, first');
    expect(out.ok && out.rows[1]!.name).toBe('say "hi"');
  });

  it('treats an empty field as NULL', () => {
    const out = parseSeedCsv('1,ada,,36', users);
    expect(out.ok && out.rows[0]!.email).toBeNull();
  });

  it('rejects a row with the wrong field count', () => {
    const out = parseSeedCsv('1,ada,ada@x.dev', users);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/3 fields, expected 4/);
  });

  it('rejects a non-number in a number column', () => {
    const out = parseSeedCsv('1,ada,ada@x.dev,old', users);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/not a number/);
  });

  it('rejects empty input and a header with no data', () => {
    expect(parseSeedCsv('   \n\n', users).ok).toBe(false);
    expect(parseSeedCsv('id,name,email,age', users).ok).toBe(false);
  });

  it('caps the row count', () => {
    const many = Array.from({ length: 501 }, (_, i) => `${i},n,e@x,1`).join('\n');
    const out = parseSeedCsv(many, users);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Too many rows/);
  });

  it('round-trips the real seed rows', () => {
    const csv = users.rows
      .map((r) => users.columns.map((c) => String(r[c])).join(','))
      .join('\n');
    const out = parseSeedCsv(csv, users);
    expect(out.ok && out.rows).toEqual(users.rows);
  });
});
