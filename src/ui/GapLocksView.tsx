import { buildIndex, keyText, leafChain, node, valuesOf } from '../engine/index/index.ts';
import type { LeafNode } from '../engine/index/index.ts';
import { indexNameOf, indexSpecsOf } from '../engine/index/spec.ts';
import { MODE_SHORT } from '../engine/locks/lockTable.ts';
import { indexLabel } from '../engine/planner/index.ts';
import type { KeyLock } from '../engine/schedule.ts';
import { buildHeap } from '../engine/storage/index.ts';
import type { Database, SqlValue } from '../engine/types.ts';
import { compareValues } from '../engine/value.ts';

/**
 * plan.md §27.5 T3: next-key locks drawn on the index they lock — its leaf level, the keys in order with a gap
 * between every two and one past the last, and on each the transactions that hold it or wait for it. A key a deleted
 * row left behind is drawn too, struck through: its transaction has not ended, so it is still in the index.
 */

type Who = Pick<KeyLock, 'holders' | 'waiters'>;

interface Item {
  kind: 'gap' | 'key';
  /** For a key, the key; for a gap, the key it sits below (null: past the last). */
  key: SqlValue[] | null;
  ghost?: boolean;
  who: Who | undefined;
}

const keyId = (key: readonly SqlValue[] | null) => (key === null ? '+' : JSON.stringify(key));

/** Index keys in index order, column by column. */
function compareKeys(a: readonly SqlValue[], b: readonly SqlValue[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = compareValues(a[i] ?? null, b[i] ?? null);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
const NOBODY: Who = { holders: [], waiters: [] };

/** The index's leaves as the B+Tree holds them now, with any key a lock still names but the table no longer has. */
function leavesOf(db: Database, table: string, index: string, rowsPerPage: number, named: readonly SqlValue[][]): SqlValue[][][] {
  const stored = db.tables[table];
  const spec = stored ? indexSpecsOf(stored).find((sp) => indexNameOf(sp.columns) === index) : undefined;
  if (!stored || !spec) return [[...named].sort(compareKeys)];
  const tree = buildIndex(buildHeap(stored, rowsPerPage), spec);
  const leaves = leafChain(tree).map((id) => {
    const keys: SqlValue[][] = [];
    for (const k of (node(tree, id) as LeafNode).keys) {
      const values = [...valuesOf(k)];
      if (keys.length === 0 || compareKeys(keys.at(-1)!, values) !== 0) keys.push(values);
    }
    return keys;
  });
  const present = new Set(leaves.flat().map(keyId));
  for (const ghost of named) {
    if (present.has(keyId(ghost))) continue;
    present.add(keyId(ghost));
    // Into the leaf whose last key is the first at or above it — or the last leaf.
    const leaf = leaves.find((l) => l.length > 0 && compareKeys(l.at(-1)!, ghost) >= 0) ?? leaves.at(-1);
    if (!leaf) leaves.push([ghost]);
    else {
      leaf.push(ghost);
      leaf.sort(compareKeys);
    }
  }
  return leaves;
}

function whoText(who: Who): string {
  const held = who.holders.map((h) => `${h.session} holds ${MODE_SHORT[h.mode]}`);
  const waiting = who.waiters.map((w) => `${w.session} waits for ${MODE_SHORT[w.mode]}`);
  return [...held, ...waiting].join(', ');
}

function Letters({ who }: { who: Who }) {
  return (
    <>
      {who.holders.map((h) => (
        <span key={`h${h.session}`} className="text-accent">
          {h.session}
        </span>
      ))}
      {who.waiters.map((w) => (
        <span key={`w${w.session}`} className="rounded-sm border border-evict px-0.5 text-evict">
          {w.session}
        </span>
      ))}
    </>
  );
}

function IndexLeaves({ table, index, locks, db, rowsPerPage }: { table: string; index: string; locks: KeyLock[]; db: Database; rowsPerPage: number }) {
  const gaps = new Map(locks.filter((k) => k.part === 'gap').map((k) => [keyId(k.key), k] as const));
  const records = new Map<string, Who>();
  for (const k of locks.filter((l) => l.part === 'record' && l.key !== null)) {
    const had = records.get(keyId(k.key)) ?? NOBODY;
    records.set(keyId(k.key), { holders: [...had.holders, ...k.holders], waiters: [...had.waiters, ...k.waiters] });
  }
  const named = locks.flatMap((k) => (k.key === null ? [] : [k.key]));
  const leaves = leavesOf(db, table, index, rowsPerPage, named);
  const columns = index.split(', ');
  const present = new Set((db.tables[table]?.rows ?? []).map((row) => keyId(columns.map((c) => row[c] ?? null))));
  const where = `${table}.${indexLabel(index)}`;
  const lastLeaf = leaves.length - 1;
  const itemsOf = (keys: SqlValue[][], last: boolean): Item[] => [
    ...keys.flatMap((key): Item[] => [
      { kind: 'gap', key, who: gaps.get(keyId(key)) },
      { kind: 'key', key, ghost: !present.has(keyId(key)), who: records.get(keyId(key)) },
    ]),
    ...(last ? [{ kind: 'gap' as const, key: null, who: gaps.get('+') }] : []),
  ];
  const keyWords = (key: SqlValue[]) => columns.map((c, i) => `${c} = ${keyText([key[i] ?? null])}`).join(', ');

  return (
    <figure className="mt-1">
      <figcaption className="mb-1 text-label text-ink-dim">
        The leaf level of <span className="font-mono text-ink">{where}</span>
      </figcaption>
      <ol className="flex flex-wrap gap-1.5" aria-label={`Leaves of ${where}, with their gaps`}>
        {leaves.map((keys, at) => (
          <li key={keys.map((k) => keyId(k)).join('|') || String(at)} className="flex items-center rounded-md border border-edge bg-surface-3 px-1 py-0.5">
            {itemsOf(keys, at === lastLeaf).map((item) => {
              const locked = item.who !== undefined && (item.who.holders.length > 0 || item.who.waiters.length > 0);
              if (item.kind === 'gap') {
                const name = item.key === null ? 'the gap past the last key' : `the gap below ${keyWords(item.key)}`;
                return locked ? (
                  <span
                    key={`g${keyId(item.key)}`}
                    className="mx-0.5 inline-flex min-h-5 items-center gap-0.5 rounded-sm border border-accent/60 bg-accent-soft px-0.5 font-mono text-[10px] leading-none"
                    title={`${name}: ${whoText(item.who!)}`}
                  >
                    <Letters who={item.who!} />
                    <span className="sr-only">
                      {name}: {whoText(item.who!)}
                    </span>
                  </span>
                ) : (
                  <span key={`g${keyId(item.key)}`} aria-hidden className="mx-0.5 h-4 w-px self-center bg-edge" />
                );
              }
              const key = item.key!;
              return (
                <span
                  key={`k${keyId(key)}`}
                  className={`inline-flex items-center gap-0.5 rounded px-1 font-mono text-label ${
                    locked ? 'bg-accent-soft text-ink' : 'text-ink-dim'
                  } ${item.ghost ? 'line-through' : ''}`}
                  title={item.ghost ? 'deleted by a transaction that has not ended: still in the index' : undefined}
                >
                  {keyText(key)}
                  {locked && (
                    <span className="font-mono text-[10px]">
                      <Letters who={item.who!} />
                    </span>
                  )}
                  {locked && <span className="sr-only">: {whoText(item.who!)} on the row</span>}
                  {item.ghost && <span className="sr-only"> (deleted, not yet committed)</span>}
                </span>
              );
            })}
          </li>
        ))}
      </ol>
    </figure>
  );
}

/** Every index with a gap lock on it, after one step of a schedule (plan.md §27.5 T3). */
export function GapLocksView({ keyLocks, db, rowsPerPage }: { keyLocks: readonly KeyLock[]; db: Database; rowsPerPage: number }) {
  const indexes = [...new Set(keyLocks.filter((k) => k.part === 'gap').map((k) => `${k.table}\u0000${k.index}`))];
  return (
    <div className="space-y-2">
      {indexes.map((pair) => {
        const [table, index] = pair.split('\u0000') as [string, string];
        const locks = keyLocks.filter((k) => k.table === table && k.index === index);
        return index === '' ? (
          <p key={pair} className="text-label text-ink-dim">
            {table} has no index, so a new row always goes at its end — and that one gap is locked: {whoText(locks[0] ?? NOBODY)}.
          </p>
        ) : (
          <IndexLeaves key={pair} table={table} index={index} locks={locks} db={db} rowsPerPage={rowsPerPage} />
        );
      })}
      <p className="text-label text-ink-dim">
        Between two keys, a gap. A letter on a gap holds S on it: no one else may insert a key there. A boxed letter is an
        insert waiting for X on it. A key with letters is a locked row; a gap and the key above it together are one
        next-key lock.
      </p>
    </div>
  );
}
