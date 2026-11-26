import { eventKey } from '../engine/eventKey.ts';
import type { EventKey } from '../engine/eventKey.ts';
import type { StepEvent, ViewState } from '../engine/index.ts';
import type { DetailLevel } from './detailLevel.ts';

/**
 * plan.md §27.5 L2 (G5, carried over): the Playground's narration at three levels of detail.
 *
 * - **Standard** is the engine's own `label`, unchanged.
 * - **Novice** is that label, and — the first time a kind of step happens in a trace — a sentence in plain words on
 *   what that kind of step is for. Only the first time: the same paragraph under every one of a scan's forty page
 *   reads would be read once and then skimmed past.
 * - **Expert** replaces the label with a terse line built from the event's own fields alone (`eventKey`): page and
 *   frame numbers, the plan on one line, the counters — never a word the event did not record.
 *
 * Both catalogues are keyed by `eventKey`, the `{key, params}` half of §25.4 H5's refactor that L2 shares; a key
 * with no novice line of its own falls back to its stage's.
 */

/** What a novice is told the first time each kind of step happens. Exported for the test that every key has one. */
export const NOVICE_LINES: Record<string, string> = {
  parse: 'Parsing turns the SQL text into a tree the database can work with. No data has been touched yet: this stage only checks how the query is put together.',
  plan: 'The plan is the recipe for answering the query: which table to read, and what to do with its rows. Rows flow up the tree, from the scan at the bottom to the top.',
  optimize: 'The optimizer rewrites the plan into one that does less work but returns exactly the same rows.',
  'optimize.none': 'The optimizer looks for a cheaper way to run the same query. Here it found none, so the plan runs as written.',
  'optimize.predicate-pushdown': 'A rewrite changes how a query runs, never what it returns. Here the WHERE test moves down to where the rows are first read.',
  'optimize.index-selection': 'An index works like the one at the back of a book: it leads straight to the matching rows, without reading the whole table.',
  'optimize.range-index-selection': 'An index keeps its keys in sorted order, so a range can start at the first match and stop after the last.',
  'optimize.index-only-scan': 'When the index holds every column the query needs, the answer can come from the index alone, without reading the table.',
  'optimize.constant-folding': 'Parts of the query that can never change, such as 1 + 1, are worked out once now rather than again for every row.',
  'optimize.join-predicate-pushdown': 'A test that is about only one table moves below the join, so fewer rows reach the join.',
  'optimize.product-to-join': 'Tables listed with a comma pair every row with every other row. The WHERE condition that links them turns those pairs into a real join.',
  'optimize.join-algorithm-selection': 'A join can be done several ways. The optimizer estimates what each would cost and picks the cheapest.',
  execute: 'An operator does its part of the work and passes its rows up the plan.',
  'execute.SeqScan': 'A sequential scan reads the table page by page, from start to finish, and checks every row.',
  'execute.IndexScan': 'The index gave the row’s exact page and slot, so only that page has to be read.',
  'execute.IndexRangeScan': 'A range scan walks the index’s leaves in key order, from the first matching key to the last.',
  'execute.IndexOnlyScan': 'Every column the query needs is in the index itself, so the table’s pages are never read.',
  'execute.Filter': 'A filter keeps the rows that pass the WHERE test and drops the rest.',
  'execute.Project': 'Projection keeps the columns the SELECT list names and drops the others.',
  'execute.Sort': 'A sort has to see every row before it can hand one back. Rows that do not fit in memory are sorted in batches, and the batches merged.',
  'execute.Limit': 'LIMIT stops once it has enough rows, so the operators below it stop early too.',
  'execute.Join': 'A join pairs the rows of two tables whose columns match the ON condition.',
  'execute.HashAggregate': 'GROUP BY sorts rows into groups with a hash table, keeping one running total per group.',
  'execute.SortAggregate': 'The rows arrive sorted, so each group’s rows come together and one group is totalled at a time.',
  'execute.Having': 'HAVING filters whole groups after they are totalled, as WHERE filters rows before.',
  'execute.HashDistinct': 'DISTINCT keeps each value once; a hash table remembers the values already seen.',
  'execute.SortDistinct': 'Sorted, duplicates sit next to each other, so DISTINCT only has to compare each row with the one before it.',
  'execute.SetOp': 'UNION, INTERSECT and EXCEPT combine the rows of two queries as sets.',
  'execute.Insert': 'The new row is written into one of the table’s pages, and every index on the table gets an entry for it.',
  'execute.Update': 'The row is changed where it is stored, and an index on a changed column is changed with it.',
  'execute.Delete': 'The row is removed from its page, and its entries from the table’s indexes.',
  buffer: 'The buffer pool keeps recently used pages in memory, so that most reads never reach the disk.',
  'buffer.hit': 'A hit: the page was already in memory, so no disk read was needed. Hits are what the buffer pool is for.',
  'buffer.miss': 'The buffer pool keeps recently used pages in memory. A miss means this page is not there, so it has to come from disk.',
  'buffer.load': 'Reading from disk is far slower than reading memory, which is why disk reads are the cost a database counts first.',
  'buffer.prefetch': 'The scan is reading pages in order, so the pool reads the next one before it is asked for.',
  'buffer.write': 'A sort writes its batches to fresh pages. They take a frame in the pool like any page read from disk.',
  'buffer.evict': 'The pool has a fixed number of frames. To make room for a new page, one already there has to go, and the replacement policy chooses which.',
  'buffer.sweep': 'The clock policy’s hand moves round the frames, lowering each one’s count, until it reaches a frame at zero to evict.',
  'buffer.log': 'Before a row on a page changes, a note of the change goes into the log: the row as it was and as it will be. With that, a crash can always be put right.',
  'buffer.flush': 'A changed page may only go to disk after the log notes that describe its changes are on disk. Otherwise a crash could leave a change nothing can undo.',
  index: 'An index is a sorted structure of keys, each pointing at the row it came from.',
  'index.open': 'A B+Tree is a short, wide tree of sorted keys. Every lookup goes from the root down to a leaf, one node per level.',
  'index.traverse': 'A node’s keys say which child to follow, the way a dictionary’s page headings tell you which way to turn.',
  'index.found': 'The key is in this leaf. A leaf stores where the row lives, a page and a slot, not the row itself.',
  'index.not-found': 'The leaf where the key would be does not have it, so no row matches, and the table never had to be read.',
  'index.chain-next': 'Leaves are linked left to right, so a range scan steps to the next leaf rather than starting again from the root.',
  lock: 'A lock stops another transaction from changing a page while this one uses it.',
  'lock.acquire': 'A lock stops another transaction from changing a page while this one uses it. A shared lock still lets others read; an exclusive lock lets no one else in.',
  'lock.release': 'Releasing the lock lets other transactions take the page again.',
  result: 'That is the answer. The counts are the work it took, and disk reads are the part that costs most.',
};

export function noviceLine(key: string): string {
  return NOVICE_LINES[key] ?? NOVICE_LINES[key.split('.')[0]!]!;
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function whyNotText(p: EventKey['params']): string {
  return typeof p.chosen === 'string' && typeof p.runnerUp === 'string'
    ? ` · ${p.chosen} ~${String(p.chosenPages)} pages vs ${p.runnerUp} ~${String(p.runnerUpPages)}`
    : '';
}

const est = (p: EventKey['params']) => (typeof p.estRows === 'number' ? ` · est. ${plural(p.estRows, 'row')}` : '');

/** The expert line for one event: its fields, tersely. `stats` are the counters after it, for the result line. */
export function expertLine({ key, params: p }: EventKey, sql: string, stats: ViewState['bufferStats']): string {
  const page = (n: string | number | boolean | undefined) => `page ${String(n)}`;
  const frame = (n: string | number | boolean | undefined) => `frame ${String(n)}`;
  switch (key) {
    case 'parse':
      return typeof p.from === 'number' && typeof p.to === 'number' ? `parse · \`${sql.slice(p.from, p.to)}\` at ${String(p.from)}–${String(p.to)}` : 'parse';
    case 'plan':
      return `plan · ${String(p.plan)}${est(p)}${whyNotText(p)}`;
    case 'optimize.none':
      return `optimize · no rule fires · ${String(p.plan)}${est(p)}`;
    case 'buffer.hit':
      return `hit · ${page(p.page)} in ${frame(p.frame)}`;
    case 'buffer.miss':
      return `miss · ${page(p.page)}`;
    case 'buffer.load':
      return `read · ${page(p.page)} → ${frame(p.frame)}`;
    case 'buffer.prefetch':
      return `prefetch · ${page(p.page)} → ${frame(p.frame)}`;
    case 'buffer.write':
      return `write · ${page(p.page)} → ${frame(p.frame)}, not from disk`;
    case 'buffer.evict':
      return `evict · ${page(p.victim)} from ${frame(p.frame)} for ${page(p.page)}${p.writtenBack ? ', written back' : ''}${p.ring ? ', ring' : ''}${p.hand === undefined ? '' : `, hand at ${String(p.hand)}`}`;
    case 'buffer.sweep':
      return `sweep · ${frame(p.frame)} usage → ${String(p.usage)}, hand at ${String(p.hand)}`;
    case 'buffer.log':
      return `log · LSN ${String(p.lsn)}, ${page(p.page)} pageLSN → ${String(p.lsn)}`;
    case 'buffer.flush':
      return `flush · log through LSN ${String(p.lsn)} before ${page(p.page)} is written`;
    case 'index.open':
      return `B+Tree · root ${String(p.node)}, height ${String(p.height)}`;
    case 'index.traverse':
      return `${String(p.node)} · key ${String(p.key)}${p.child === undefined ? '' : ` → child ${String(p.child)}`}`;
    case 'index.found':
      return `${String(p.node)} · found ${String(p.key)}`;
    case 'index.not-found':
      return `${String(p.node)} · no ${String(p.key)}`;
    case 'index.chain-next':
      return `leaf ${String(p.from)} → ${String(p.to)}`;
    case 'lock.acquire':
    case 'lock.release':
      return `${p.mode === 'exclusive' ? 'X' : 'S'} lock · ${page(p.page)} ${key === 'lock.acquire' ? 'taken' : 'released'}`;
    case 'result':
      return `result · ${plural(Number(p.rows), 'row')} · ${plural(stats.misses, 'miss', 'misses')}, ${plural(stats.hits, 'hit')}, ${plural(stats.evictions, 'eviction')}${
        stats.prefetches > 0 ? `, ${plural(stats.prefetches, 'prefetch', 'prefetches')}` : ''
      }`;
  }
  if (key.startsWith('optimize.')) return `rewrite ${String(p.rule)} ⇒ ${String(p.plan)}${est(p)}${whyNotText(p)}`;
  // execute.*
  return `${String(p.op)}${typeof p.table === 'string' ? ` ${p.table}` : ''} · ${plural(Number(p.rows), 'row')} so far`;
}

/** The ids of the events that are the first of their kind (`eventKey`) in a trace: where a novice line is shown. */
export function firstOfEachKind(events: readonly StepEvent[]): ReadonlySet<number> {
  const seen = new Set<string>();
  const firsts = new Set<number>();
  for (const e of events) {
    const { key } = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.add(e.id);
  }
  return firsts;
}

export interface Narrated {
  /** The line itself: the label, or the expert line. */
  text: string;
  /** A novice's plain-words sentence, on the first step of its kind. */
  gloss?: string;
  /** The expert line: shown in the monospace face, as a log line is. */
  terse: boolean;
}

/** The narration for the step `state` is on, at `level`. Before the first step there is nothing to tell. */
export function narrationAt(state: ViewState, level: DetailLevel, sql: string, firsts: ReadonlySet<number>): Narrated {
  const e = state.lastEvent;
  if (e === null) return { text: state.narration, terse: false };
  if (level === 'expert') return { text: expertLine(eventKey(e), sql, state.bufferStats), terse: true };
  if (level === 'novice' && firsts.has(e.id)) return { text: state.narration, gloss: noviceLine(eventKey(e).key), terse: false };
  return { text: state.narration, terse: false };
}
