/** plan.md §27.5 X1 — partitioning: every row placed, and a change moves only what each scheme says it moves. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATASETS } from '../datasets.ts';
import { fnv, partition } from '../partitioning.ts';
import type { PartitionScheme } from '../partitioning.ts';
import type { Row } from '../types.ts';

const ROWS = DATASETS.transactions.make().tables.transactions!.rows;

describe('placing rows (plan.md §27.5 X1)', () => {
  it('puts every row on exactly one of the nodes, and counts them', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 500 }), { minLength: 1, maxLength: 120 }),
        fc.constantFrom<PartitionScheme>('hash', 'range', 'consistent'),
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 64 }),
        (keys, scheme, nodes, virtualNodes) => {
          const rows: Row[] = keys.map((k) => ({ k }));
          const r = partition(rows, 'k', { scheme, nodes, virtualNodes, change: { kind: 'none' } });
          expect(r.before.nodes).toEqual(Array.from({ length: nodes }, (_, i) => i + 1));
          for (const node of r.before.rowNode) expect(r.before.nodes).toContain(node);
          expect(r.before.counts.reduce((s, x) => s + x, 0)).toBe(rows.length);
          expect(r.after).toBeNull();
        },
      ),
      { numRuns: 200, seed: 5 },
    );
  });

  it('hashes the same text to the same number, and spreads many keys evenly', () => {
    expect(fnv('acct-01')).toBe(fnv('acct-01'));
    const buckets = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 10_000; i++) buckets[fnv(String(i)) % 10]! += 1;
    for (const b of buckets) expect(Math.abs(b - 1000)).toBeLessThan(120);
  });
});

describe('a node joins or leaves (plan.md §27.5 X1)', () => {
  const changeArb = fc.oneof(fc.constant({ kind: 'add' as const }), fc.integer({ min: 1, max: 10 }).map((node) => ({ kind: 'remove' as const, node })));

  it('consistent hashing and range move rows only onto a joining node, or only off a leaving one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 150 }),
        fc.constantFrom<PartitionScheme>('range', 'consistent'),
        fc.integer({ min: 2, max: 9 }),
        fc.integer({ min: 1, max: 32 }),
        changeArb,
        (keys, scheme, nodes, virtualNodes, change) => {
          const rows: Row[] = keys.map((k) => ({ k }));
          const leaving = change.kind === 'remove' ? Math.min(change.node, nodes) : -1;
          const r = partition(rows, 'k', { scheme, nodes, virtualNodes, change: change.kind === 'remove' ? { kind: 'remove', node: leaving } : change });
          const after = r.after!;
          expect(after.counts.reduce((s, x) => s + x, 0)).toBe(rows.length);
          r.before.rowNode.forEach((was, i) => {
            const now = after.rowNode[i]!;
            if (was === now) return;
            if (change.kind === 'add') expect(now).toBe(nodes + 1);
            else expect(was).toBe(leaving);
          });
          if (change.kind === 'remove') expect(r.moved).toBe(r.minimum);
        },
      ),
      { numRuns: 300, seed: 6 },
    );
  });

  it('hash moves most rows when the cluster grows: every remainder changes with n', () => {
    const r = partition(ROWS, 'id', { scheme: 'hash', nodes: 4, virtualNodes: 1, change: { kind: 'add' } });
    expect([r.moved, r.minimum]).toEqual([2399, 600]);
    expect(r.before.skew.toFixed(2)).toBe('1.05');
  });

  it('range moves half of the fullest range to a newcomer, and the next ids all land on the last node', () => {
    const add = partition(ROWS, 'id', { scheme: 'range', nodes: 4, virtualNodes: 1, change: { kind: 'add' } });
    expect([add.moved, add.after!.counts.join('/'), add.after!.skew.toFixed(2)]).toEqual([375, '375/375/750/750/750', '1.25']);
    expect(add.inserts.counts).toEqual([0, 0, 0, 300]);
    const remove = partition(ROWS, 'id', { scheme: 'range', nodes: 4, virtualNodes: 1, change: { kind: 'remove', node: 2 } });
    expect([remove.moved, remove.minimum]).toEqual([750, 750]);
  });

  it('consistent hashing: one point each is lumpy; sixty-four even it out and move about a fair share', () => {
    const one = partition(ROWS, 'id', { scheme: 'consistent', nodes: 4, virtualNodes: 1, change: { kind: 'add' } });
    expect([one.before.skew.toFixed(2), one.moved]).toEqual(['1.96', 1459]);
    const many = partition(ROWS, 'id', { scheme: 'consistent', nodes: 4, virtualNodes: 64, change: { kind: 'add' } });
    expect([many.before.skew.toFixed(2), many.moved, many.after!.skew.toFixed(2)]).toEqual(['1.07', 590, '1.10']);
  });

  it('forty keys cannot be spread as evenly as three thousand', () => {
    const accounts = partition(ROWS, 'account', { scheme: 'hash', nodes: 4, virtualNodes: 1, change: { kind: 'none' } });
    expect(accounts.before.skew.toFixed(2)).toBe('1.40');
  });
});
