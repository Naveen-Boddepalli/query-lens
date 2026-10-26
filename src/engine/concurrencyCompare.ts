/**
 * One schedule, every concurrency-control protocol (plan.md §25.4 D6). The five here are the ones the schedule runner
 * implements, each set to the strongest level it offers, so that the comparison is of *how* they get their answer and
 * what that costs, not of how much they promise.
 *
 * The runner does the work; this module reads each run back as a bill: who waited, who was thrown away and how much
 * work went with them, what anomalies were let through, and whether what survived is what running the committed
 * transactions one at a time would have left. Nothing here is a model of the protocols — the numbers are counted off
 * runs.
 */

import { runSchedule } from './schedule.ts';
import type { AnomalyKind, LockingOptions, ScheduleResult, ScheduleStep } from './schedule.ts';
import { createAccountsDatabase } from './seed.ts';
import { serialCheck, transactionsOf } from './serialCheck.ts';
import type { SerialCheck, TransactionOutcome } from './serialCheck.ts';
import type { Row } from './types.ts';

export type ProtocolId = 'two-phase' | 'timestamp' | 'optimistic' | 'snapshot' | 'serializable-snapshot';

export interface Protocol {
  id: ProtocolId;
  label: string;
  /** What it does when two transactions want the same thing. */
  rule: string;
  /** What that costs, in a sentence. */
  price: string;
  locking: LockingOptions;
  /** The serial order its guarantee is about: when transactions committed, or when they began. */
  order: 'commit' | 'begin';
  /** Whether it claims serializability. A protocol that does not is shown what it lets through, not faulted for it. */
  claimsSerializable: boolean;
}

export const PROTOCOLS: readonly Protocol[] = [
  {
    id: 'two-phase',
    label: 'Two-phase locking',
    rule: 'Takes a lock before every read and write and keeps all of them to the end. A statement that cannot get its lock waits; if the waiting forms a cycle, the youngest is rolled back.',
    price: 'Waiting, and now and then a deadlock.',
    locking: { granularity: 'row', isolation: 'serializable' },
    order: 'commit',
    claimsSerializable: true,
  },
  {
    id: 'timestamp',
    label: 'Timestamp ordering',
    rule: 'Gives each transaction a timestamp when it begins and makes everything happen in that order. An operation that arrives too late for it is aborted on the spot, never made to wait.',
    price: 'Aborts, and the work before them. Not strict: it can act on what is later rolled back.',
    locking: { granularity: 'row', protocol: 'timestamp' },
    order: 'begin',
    claimsSerializable: true,
  },
  {
    id: 'optimistic',
    label: 'Optimistic validation',
    rule: 'Takes nothing, waits for nothing: each transaction works in a private copy, and at COMMIT is checked against everything that committed since it began.',
    price: 'All the work, thrown away at the end when it conflicts.',
    locking: { granularity: 'row', protocol: 'optimistic' },
    order: 'commit',
    claimsSerializable: true,
  },
  {
    id: 'snapshot',
    label: 'Snapshots',
    rule: 'Readers see the data as of a snapshot and never wait; writers lock the rows they change, and a write over a row changed since the snapshot fails (first committer wins).',
    price: 'Cheap, and write skew gets through.',
    locking: { granularity: 'row', isolation: 'repeatable-read', mvcc: true },
    order: 'commit',
    claimsSerializable: false,
  },
  {
    id: 'serializable-snapshot',
    label: 'Serializable snapshots',
    rule: 'Snapshots, plus a check at COMMIT that nothing the transaction read has changed since its snapshot. A simpler check than PostgreSQL’s SSI: it refuses more than it must.',
    price: 'Some aborts at commit, for what is read as well as what is written.',
    locking: { granularity: 'row', isolation: 'serializable', mvcc: true },
    order: 'commit',
    claimsSerializable: true,
  },
];

export interface ProtocolOutcome {
  protocol: Protocol;
  result: ScheduleResult;
  transactions: TransactionOutcome[];
  /** Transactions that committed and did something: BEGIN … COMMIT, or a write that ran on its own. */
  committed: number;
  /** Transactions the protocol ended: deadlock victims, timestamp refusals, failed validations. */
  aborted: TransactionOutcome[];
  /** Transactions a session ended with ROLLBACK itself. */
  rolledBack: number;
  /** Statements that had to wait for a lock. */
  waits: number;
  /** Statements that ran inside a transaction the protocol then aborted: work done and lost. */
  wasted: number;
  /**
   * Which anomalies reached a transaction that was not then aborted, once each. One a protocol caught before it
   * committed — a phantom a validation refuses at COMMIT — was seen, but not let through.
   */
  anomalies: AnomalyKind[];
  check: SerialCheck;
  /** True when some one-at-a-time order of the committed transactions explains the run. See `check.exhaustive`. */
  serializable: boolean;
  /** How the table that survives differs from the one the schedule began with, in a few short phrases. */
  changes: string[];
}

const rowText = (row: Row): string => `(${Object.values(row).map((v) => String(v ?? 'NULL')).join(', ')})`;

/** How `after` differs from `before`, matched up by id where an id still exists. */
export function tableChanges(before: readonly Row[], after: readonly Row[], limit = 6): string[] {
  const key = (r: Row) => JSON.stringify(r);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const added = after.filter((r) => !beforeKeys.has(key(r)));
  const removed = before.filter((r) => !afterKeys.has(key(r)));
  const notes: string[] = [];
  const used = new Set<Row>();
  for (const now of added) {
    const was = removed.find((r) => r.id === now.id && !used.has(r));
    if (was) {
      used.add(was);
      const columns = Object.keys(now).filter((c) => was[c] !== now[c]);
      notes.push(
        `id ${String(now.id)}: ${columns.map((c) => `${c} ${String(was[c] ?? 'NULL')} → ${String(now[c] ?? 'NULL')}`).join(', ')}`,
      );
    } else notes.push(`added ${rowText(now)}`);
  }
  for (const gone of removed) if (!used.has(gone)) notes.push(`id ${String(gone.id)} removed`);
  return notes.length > limit ? [...notes.slice(0, limit), `and ${String(notes.length - limit)} more`] : notes;
}

export function runProtocol(protocol: Protocol, steps: readonly ScheduleStep[], rows: number): ProtocolOutcome {
  const start = createAccountsDatabase(rows);
  const result = runSchedule(steps, start, undefined, protocol.locking);
  const transactions = transactionsOf(result);
  const aborted = transactions.filter((t) => t.fate === 'aborted');
  const check = serialCheck(result, rows, protocol.order);
  const caught = (at: number, session: string) =>
    aborted.some((t) => t.session === session && t.began <= at && at <= t.ended);
  const anomalies = [
    ...new Set(
      result.steps.flatMap((s, at) => (caught(at, s.session) ? [] : s.anomalies.map((a) => a.kind))),
    ),
  ];
  return {
    protocol,
    result,
    transactions,
    committed: transactions.filter((t) => t.fate === 'committed' && (t.explicit || t.writes)).length,
    aborted,
    rolledBack: transactions.filter((t) => t.fate === 'rolled-back').length,
    waits: result.steps.filter((s) => s.phase === 'blocked').length,
    wasted: aborted.reduce((n, t) => n + t.statements.length, 0),
    anomalies,
    check,
    serializable: check.serializable,
    changes: tableChanges(start.tables.accounts?.rows ?? [], result.committed.tables.accounts?.rows ?? []),
  };
}

/** The same schedule under every protocol. */
export function compareProtocols(steps: readonly ScheduleStep[], rows: number): ProtocolOutcome[] {
  return PROTOCOLS.map((p) => runProtocol(p, steps, rows));
}
