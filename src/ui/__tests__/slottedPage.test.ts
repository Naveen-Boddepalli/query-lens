import { describe, expect, it } from 'vitest';
import { createSeedDatabase } from '../../engine/index.ts';
import { layOutPage } from '../slottedPage.ts';

const users = createSeedDatabase().tables.users!;
const cols = users.columns;

describe('layOutPage', () => {
  it('accounts for every byte: header + slots + tuples + free = page', () => {
    const page = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 4096 });
    const tupleTotal = page.tuples.reduce((n, t) => n + t.length, 0);
    expect(page.headerBytes + page.slotArrayBytes + tupleTotal + page.freeBytes).toBe(4096);
    expect(page.usedBytes + page.freeBytes).toBe(4096);
    expect(page.overflow).toBe(false);
  });

  it('gives one slot per row and packs tuples from the high end down', () => {
    const page = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 4096 });
    expect(page.tuples).toHaveLength(4);
    expect(page.slotArrayBytes).toBe(4 * page.slotBytes);
    // Slot 0 sits highest; each later tuple starts lower and they do not overlap.
    for (let i = 1; i < page.tuples.length; i++) {
      const prev = page.tuples[i - 1]!;
      const cur = page.tuples[i]!;
      expect(cur.offset).toBeLessThan(prev.offset);
      expect(cur.offset + cur.length).toBeLessThanOrEqual(prev.offset);
    }
    // The last tuple must end before the header + slot array.
    const last = page.tuples.at(-1)!;
    expect(last.offset).toBeGreaterThanOrEqual(page.headerBytes + page.slotArrayBytes);
  });

  it('sizes a tuple as its header plus its fields', () => {
    const [row] = users.rows;
    const page = layOutPage([row!], cols, { pageBytes: 4096, tupleHeaderBytes: 8 });
    const t = page.tuples[0]!;
    expect(t.headerBytes).toBe(8);
    expect(t.length).toBe(8 + t.fields.reduce((n, f) => n + f.bytes, 0));
    // id and age are numbers (4 bytes); name and email are text (bytes + 1).
    const byCol = Object.fromEntries(t.fields.map((f) => [f.column, f.bytes]));
    expect(byCol.id).toBe(4);
    expect(byCol.age).toBe(4);
    expect(byCol.name).toBe((row!.name as string).length + 1);
  });

  it('reports how many more rows the free space holds, and flags overflow', () => {
    const roomy = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 4096 });
    expect(roomy.moreRowsFit).toBeGreaterThan(10); // 4 toy rows barely dent a 4 KB page
    expect(roomy.freeBytes).toBeGreaterThan(3000);

    const tight = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 64 });
    expect(tight.overflow).toBe(true);
    expect(tight.moreRowsFit).toBe(0);
    expect(tight.freeBytes).toBe(0);
  });

  it('handles an empty page', () => {
    const page = layOutPage([], cols, { pageBytes: 4096 });
    expect(page.tuples).toHaveLength(0);
    expect(page.slotArrayBytes).toBe(0);
    expect(page.freeBytes).toBe(4096 - page.headerBytes);
    expect(page.moreRowsFit).toBe(0);
  });

  it('is deterministic', () => {
    const a = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 2048 });
    const b = layOutPage(users.rows.slice(0, 4), cols, { pageBytes: 2048 });
    expect(a).toEqual(b);
  });
});
