import { describe, expect, it } from 'vitest';
import { runQuery } from '../runQuery.ts';
import { createSeedDatabase } from '../seed.ts';
import { DATASETS } from '../datasets.ts';
import type { Row, StepEvent } from '../types.ts';

const db = () => createSeedDatabase();
const run = (sql: string) => runQuery(sql, db());

const users = createSeedDatabase().tables.users!;
function expected(predicate: (r: Row) => boolean): Row[] {
  return users.rows.filter(predicate);
}

describe('IndexRangeScan — correctness (plan.md §23.1)', () => {
  it('agrees with a plain filter for a lower-bound-only range', () => {
    expect(run('SELECT * FROM users WHERE id > 40').rows).toEqual(expected((r) => (r.id as number) > 40));
  });

  it('agrees with a plain filter for an upper-bound-only range', () => {
    expect(run('SELECT * FROM users WHERE id < 10').rows).toEqual(expected((r) => (r.id as number) < 10));
  });

  it('>= and <= are inclusive at the boundary', () => {
    expect(run('SELECT * FROM users WHERE id >= 45').rows).toEqual(
      expected((r) => (r.id as number) >= 45),
    );
    expect(run('SELECT * FROM users WHERE id <= 5').rows).toEqual(
      expected((r) => (r.id as number) <= 5),
    );
  });

  it('a BETWEEN spans both bounds, inclusive on each end', () => {
    expect(run('SELECT * FROM users WHERE id BETWEEN 10 AND 15').rows).toEqual(
      expected((r) => (r.id as number) >= 10 && (r.id as number) <= 15),
    );
  });

  it('a range past the last key returns nothing, not an error', () => {
    expect(run('SELECT * FROM users WHERE id > 9999').rows).toEqual([]);
  });

  it('a range before the first key returns nothing, not an error', () => {
    expect(run('SELECT * FROM users WHERE id < -1').rows).toEqual([]);
  });

  it('an impossible range (low above high) returns nothing', () => {
    expect(run('SELECT * FROM users WHERE id > 40 AND id < 10').rows).toEqual([]);
  });

  it('works on a different table and a different index too', () => {
    const orders = DATASETS.orders.make();
    const table = orders.tables[Object.keys(orders.tables)[0]!]!;
    const { rows } = runQuery(`SELECT * FROM ${table.name} WHERE id > 1`, orders);
    expect(rows).toEqual(table.rows.filter((r) => (r.id as number) > 1));
  });
});

describe('IndexRangeScan — the leaf-chaining walk itself', () => {
  it('crosses more than one leaf for a range wide enough to need it (48 rows, 4-key leaves)', () => {
    const { events } = run('SELECT * FROM users WHERE id > 43');
    const hops = events.filter((e) => e.stage === 'index' && e.action === 'chain-next');
    expect(hops.length).toBeGreaterThan(0);
  });

  it('every chain-next hop names a real from/to leaf pair, and each "to" becomes the next hop\'s "from"', () => {
    const { events } = run('SELECT * FROM users WHERE id > 43');
    const hops = events.filter(
      (e): e is Extract<StepEvent, { stage: 'index'; action: 'chain-next' }> =>
        e.stage === 'index' && e.action === 'chain-next',
    );
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i]!.fromNodeId).toBe(hops[i - 1]!.toNodeId);
    }
  });

  it('reads each sibling leaf through the buffer pool — a hop is a page read, not free bookkeeping', () => {
    const { events } = run('SELECT * FROM users WHERE id > 43');
    const hops = events.filter((e) => e.stage === 'index' && e.action === 'chain-next').length;
    // Locks on the index's own pages (numbered past the heap) are one per node visited: the descent, then one per hop.
    const heapPages = createSeedDatabase().tables.users!.rows.length / 4;
    const indexLocks = events.filter((e) => e.stage === 'lock' && e.action === 'acquire' && e.pageId >= heapPages).length;
    const height = events.find((e) => e.stage === 'index' && e.action === 'open');
    expect(height?.stage === 'index' && height.action === 'open' ? indexLocks : -1).toBe(
      (height?.stage === 'index' && height.action === 'open' ? height.height : 0) + hops,
    );
  });

  it('a narrow range that fits in one leaf takes no chain-next hop at all', () => {
    const { events } = run('SELECT * FROM users WHERE id BETWEEN 1 AND 2');
    const hops = events.filter((e) => e.stage === 'index' && e.action === 'chain-next');
    expect(hops).toHaveLength(0);
  });

  it('with no lower bound, the narration says so and starts at the leftmost leaf', () => {
    const { events } = run('SELECT * FROM users WHERE id < 3');
    const open = events.find((e) => e.stage === 'index' && e.action === 'open');
    expect(open?.label).toMatch(/no lower bound/);
  });
});

describe('IndexRangeScan — residual recheck', () => {
  it('keeps a conjunct the range cannot answer as a per-row recheck', () => {
    expect(run("SELECT * FROM users WHERE id > 40 AND name = 'nobody'").rows).toEqual([]);
    expect(run('SELECT * FROM users WHERE id > 40 AND age > 0').rows).toEqual(
      expected((r) => (r.id as number) > 40 && (r.age as number) > 0),
    );
  });
});

describe('IndexRangeScan — the pipeline', () => {
  it('balances every lock it takes, across every leaf and every matched heap page', () => {
    let held = 0;
    for (const e of run('SELECT * FROM users WHERE id > 40').events) {
      if (e.stage !== 'lock') continue;
      held += e.action === 'acquire' ? 1 : -1;
    }
    expect(held).toBe(0);
  });

  it('the optimizer runs range-index-selection, not index-selection, for a pure range', () => {
    const { events } = run('SELECT * FROM users WHERE id > 40');
    const rules = events.flatMap((e) => (e.stage === 'optimize' ? [e.rule] : []));
    expect(rules).toEqual(['predicate-pushdown', 'range-index-selection']);
  });

  it('ends with a result event whose rows match', () => {
    const { events, rows } = run('SELECT * FROM users WHERE id > 40');
    expect(events.at(-1)?.stage).toBe('result');
    const result = events.find((e) => e.stage === 'result');
    expect(result?.stage === 'result' && result.rows).toEqual(rows);
  });

  it('is deterministic', () => {
    const a = run('SELECT * FROM users WHERE id > 40');
    const b = run('SELECT * FROM users WHERE id > 40');
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
  });

  it('every event survives structured cloning, keeping the engine worker-ready', () => {
    const { events } = run('SELECT * FROM users WHERE id > 40');
    expect(structuredClone(events)).toEqual(events);
  });
});

describe('IndexRangeScan — excluded from DELETE/UPDATE (WRITE_PATH_RULES, plan.md §23.1)', () => {
  // exec/delete.ts and exec/update.ts only know how to run a SeqScan or a
  // single-row IndexScan to find their target rows (indexScanForMatch) — not
  // an IndexRangeScan's multi-row leaf walk. If range-index-selection ever
  // reached a write statement's plan, its executor would silently fall back
  // to "no filter at all" and touch every row instead of just the matching
  // ones. These tests are the guard against that regression.
  it('DELETE with a range predicate on the indexed column removes only the matching rows', () => {
    const before = createSeedDatabase();
    const total = before.tables.users!.rows.length;
    const toDelete = before.tables.users!.rows.filter((r) => (r.id as number) > 40).length;
    expect(toDelete).toBeGreaterThan(0);
    expect(toDelete).toBeLessThan(total);

    const result = runQuery('DELETE FROM users WHERE id > 40', before);
    expect(result.write?.kind).toBe('delete');
    expect(result.write?.kind === 'delete' && result.write.deletedCount).toBe(toDelete);
    expect(result.write?.rows).toHaveLength(total - toDelete);
  });

  it('UPDATE with a range predicate on the indexed column modifies only the matching rows', () => {
    const before = createSeedDatabase();
    const toUpdate = before.tables.users!.rows.filter((r) => (r.id as number) > 40).length;
    expect(toUpdate).toBeGreaterThan(0);

    const result = runQuery("UPDATE users SET name = 'renamed' WHERE id > 40", before);
    expect(result.write?.kind).toBe('update');
    const rows = result.write?.kind === 'update' ? result.write.rows : [];
    const renamed = rows.filter((r) => r.name === 'renamed');
    const untouched = rows.filter((r) => r.name !== 'renamed');
    expect(renamed).toHaveLength(toUpdate);
    expect(untouched.every((r) => (r.id as number) <= 40)).toBe(true);
  });
});
