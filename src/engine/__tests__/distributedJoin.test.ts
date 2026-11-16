/** plan.md §27.5 X4 — a join across partitions: every strategy finds every match, and costs what it says in rows moved. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distributedJoin } from '../distributedJoin.ts';
import type { JoinSide } from '../distributedJoin.ts';
import { compare } from '../exec/evaluate.ts';
import { hashKeyOf } from '../partitioning.ts';
import type { PartitionScheme } from '../partitioning.ts';

const tableArb = (name: string) =>
  fc.array(fc.record({ k: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }), other: fc.integer({ min: 0, max: 50 }) }), { minLength: 1, maxLength: 60 }).map((rows) => ({ name, rows }));
const schemeArb = fc.constantFrom<PartitionScheme>('hash', 'range', 'consistent');

describe('a join across partitions (plan.md §27.5 X4)', () => {
  it('finds every match whichever strategy runs it, and prices a broadcast and a co-located join as it says', () => {
    fc.assert(
      fc.property(tableArb('l'), tableArb('r'), schemeArb, schemeArb, fc.boolean(), fc.boolean(), fc.integer({ min: 2, max: 8 }), (l, r, ls, rs, lByKey, rByKey, nodes) => {
        const left: JoinSide = { name: 'l', rows: l.rows, joinColumn: 'k', partitionColumn: lByKey ? 'k' : 'other', scheme: ls };
        const right: JoinSide = { name: 'r', rows: r.rows, joinColumn: 'k', partitionColumn: rByKey ? 'k' : 'other', scheme: rs };
        const result = distributedJoin(left, right, nodes, 8);
        for (const s of result.strategies) if (s.possible) expect(s.matches, s.strategy).toBe(result.serialMatches);
        const co = result.strategies.find((s) => s.strategy === 'co-located')!;
        expect(co.possible).toBe(ls === rs && ls !== 'range' && lByKey && rByKey);
        if (co.possible) expect(co.moved).toBe(0);
        const small = Math.min(l.rows.length, r.rows.length);
        expect(result.strategies.find((s) => s.strategy === 'broadcast')!.moved).toBe(small * (nodes - 1));
        const shuffle = result.strategies.find((s) => s.strategy === 'shuffle')!;
        expect(shuffle.moved).toBeLessThanOrEqual(l.rows.length + r.rows.length);
        expect(shuffle.perNode.reduce((s, x) => s + x, 0)).toBe(l.rows.length + r.rows.length);
      }),
      { numRuns: 300, seed: 21 },
    );
  });

  it('a shuffle moves nothing when both sides already sit where the hash of their key puts them', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ k: i % 7 }));
    const side = (name: string): JoinSide => ({ name, rows, joinColumn: 'k', partitionColumn: 'k', scheme: 'hash' });
    const r = distributedJoin(side('a'), side('b'), 4, 1);
    expect(r.strategies.map((s) => [s.strategy, s.moved])).toEqual([['co-located', 0], ['broadcast', 120], ['shuffle', 0]]);
  });

  it('hashes a key as the engine’s `=` compares it: equal values share a key, unequal ones do not', () => {
    const value = fc.oneof(fc.integer({ min: -3, max: 12 }), fc.constantFrom('1', '01', '0', 'a', 'null', 'true', ''), fc.boolean());
    fc.assert(
      fc.property(value, value, (a, b) => {
        expect(hashKeyOf(a) === hashKeyOf(b), `${JSON.stringify(a)} = ${JSON.stringify(b)}`).toBe(compare('=', a, b) === true);
      }),
      { numRuns: 500, seed: 22 },
    );
  });

  it('matches \'1\' and TRUE to 1 as `=` does, but never a NULL — not even to the text \'null\'', () => {
    const left: JoinSide = { name: 'l', rows: [{ k: '1' }, { k: true }, { k: 'null' }, { k: null }], joinColumn: 'k', partitionColumn: 'k', scheme: 'hash' };
    const right: JoinSide = { name: 'r', rows: [{ k: 1 }, { k: 1 }, { k: null }, { k: 2 }], joinColumn: 'k', partitionColumn: 'k', scheme: 'hash' };
    const r = distributedJoin(left, right, 3, 4);
    expect(r.serialMatches).toBe(4);
    expect(r.colocated).toBe(true);
    expect(r.strategies.map((s) => [s.strategy, s.matches])).toEqual([['co-located', 4], ['broadcast', 4], ['shuffle', 4]]);
    // Hashed alike already, nothing needs to move — the NULLs least of all.
    expect(r.strategies.find((s) => s.strategy === 'shuffle')!.moved).toBe(0);
  });

  it('a shuffle leaves a row whose key is NULL where it is: it can match nothing, so sending it would be waste', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ k: null, other: i }));
    const side = (name: string): JoinSide => ({ name, rows, joinColumn: 'k', partitionColumn: 'other', scheme: 'hash' });
    const r = distributedJoin(side('a'), side('b'), 4, 1);
    expect(r.serialMatches).toBe(0);
    expect(r.strategies.find((s) => s.strategy === 'shuffle')!.moved).toBe(0);
  });
});
