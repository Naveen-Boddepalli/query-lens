/**
 * Runs a script challenge: parses what the player wrote, runs it on the engine the challenge is about, and applies the
 * challenge's check — a pure predicate over what the engine did, as `challenges.tsx` does for a query. Everything here
 * imports the schedule runner or the log machine, so this module is loaded only when a script challenge is opened.
 *
 * A check says what the engine did, not what the script looks like: a schedule passes because the run flagged a lost
 * update that then committed, not because it contains a particular statement. Each one is held against its known
 * solution and the near-misses it must reject in `__tests__/scriptChallenges.test.ts`.
 */

import type { ReactNode } from 'react';
import { compareProtocols } from '../../engine/concurrencyCompare.ts';
import type { ProtocolOutcome } from '../../engine/concurrencyCompare.ts';
import { committedCells, databaseCells, formatWalStep, parseWalStep, runWal, MAX_WAL_STEPS } from '../../engine/recovery/wal.ts';
import type { Cell, RecoveryReport, WalRun, WalStep } from '../../engine/recovery/wal.ts';
import { runQuery } from '../../engine/runQuery.ts';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../../engine/schedule.ts';
import type { LockingOptions, ScheduleResult, ScheduleStep } from '../../engine/schedule.ts';
import { createAccountsDatabase } from '../../engine/seed.ts';
import { serialCheck, transactionsOf } from '../../engine/serialCheck.ts';
import { MAX_STATEMENT_LENGTH } from '../../ui/scheduleUrl.ts';
import { SCHEDULE_COLUMNS, scheduleRows } from '../../ui/transactionTables.ts';
import { recoveryRows } from '../../ui/walTables.ts';
import { scenarioHref } from '../learn/transactionScenarios.ts';
import type { ScheduleLine } from '../learn/transactionScenarios.ts';
import type { ScriptChallenge } from './scriptChallenges.tsx';

export interface ScriptTable {
  caption: string;
  columns: string[];
  rows: string[][];
}

export interface ScriptRun {
  /** Why the text could not be run at all: a line that is not a step, or too many of them. */
  problem: string | null;
  passed: boolean;
  /** A few numbers about the run, labelled — what the page shows beside the verdict. */
  facts: { label: string; value: string }[];
  tables: ScriptTable[];
  /** The tool that shows this very run in full. */
  toolHref: string | null;
}

export interface Parsed<T> {
  steps: T[];
  problem: string | null;
}

const WAL_FORMS =
  'begin T1 · set T1 a = 99 · commit T1 · abort T1 · flush log · write page 1 · read page 1 · checkpoint · crash · recover · recover, crash after 1';

/** One step to a line, `A: statement` or `B: statement`. Blank lines and lines starting `--` are skipped. */
export function parseSchedule(text: string): Parsed<ScheduleStep> {
  const steps: ScheduleStep[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('--')) continue;
    const m = /^([ab])\s*:\s*(.*)$/i.exec(line);
    if (!m) return { steps, problem: `Line ${String(i + 1)}: begin each step with A: or B:, as in “A: BEGIN”.` };
    const sql = m[2]!.trim().replace(/\s*;+$/, '');
    if (sql === '') return { steps, problem: `Line ${String(i + 1)}: there is nothing after “${m[1]!.toUpperCase()}:”.` };
    if (sql.length > MAX_STATEMENT_LENGTH) {
      return { steps, problem: `Line ${String(i + 1)}: a statement is at most ${String(MAX_STATEMENT_LENGTH)} characters.` };
    }
    steps.push({ session: m[1]!.toUpperCase(), sql });
  }
  if (steps.length === 0) return { steps, problem: 'Write at least one step.' };
  if (steps.length > MAX_SCHEDULE_STEPS) {
    return { steps, problem: `A schedule is at most ${String(MAX_SCHEDULE_STEPS)} steps; this one has ${String(steps.length)}.` };
  }
  return { steps, problem: null };
}

/** One step to a line, in the words the write-ahead-log tool uses. Blank lines and lines starting `--` are skipped. */
export function parseWal(text: string): Parsed<WalStep> {
  const steps: WalStep[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('--')) continue;
    const step = parseWalStep(line);
    if (!step) {
      return { steps, problem: `Line ${String(i + 1)}: “${line.slice(0, 40)}” is not a step. The steps are ${WAL_FORMS}.` };
    }
    steps.push(step);
  }
  if (steps.length === 0) return { steps, problem: 'Write at least one step.' };
  if (steps.length > MAX_WAL_STEPS) {
    return { steps, problem: `A script is at most ${String(MAX_WAL_STEPS)} steps; this one has ${String(steps.length)}.` };
  }
  return { steps, problem: null };
}

// — what the checks read —

const sameCells = (a: Record<string, Cell>, b: Record<string, Cell>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
};

/** The last recovery that ran to the end, where in the run it was, and the report of its three passes. */
function lastRecovery(run: WalRun): { at: number; report: RecoveryReport } | null {
  for (let at = run.steps.length - 1; at >= 0; at -= 1) {
    const r = run.steps[at]!;
    if (r.recovery && !r.recovery.interrupted && !r.error) return { at, report: r.recovery };
  }
  return null;
}

/** Whether the database right after step `at` is the one the committed transactions left. */
function matchesCommitted(run: WalRun, at: number): boolean {
  const state = run.steps[at]!.state;
  return !state.crashed && sameCells(databaseCells(state), committedCells(state, run.options.pages));
}

/** Whether log record `lsn` is a change by a transaction that has a commit record. */
function isCommittedChange(run: WalRun, lsn: number): boolean {
  const record = run.final.log.find((r) => r.lsn === lsn);
  return (
    record?.type === 'update' && run.final.log.some((r) => r.type === 'commit' && r.txn === record.txn)
  );
}

/** Whether record position `at` of a schedule's run lies inside a transaction of `session` that ended as `fate`. */
function inside(result: ScheduleResult, at: number, session: string, fate: 'committed' | 'rolled-back'): boolean {
  return transactionsOf(result).some((t) => t.session === session && t.began <= at && at <= t.ended && t.fate === fate);
}

interface ScheduleContext {
  result: ScheduleResult;
  rows: number;
}

const SCHEDULE_CHECKS: Record<string, (c: ScheduleContext) => boolean> = {
  // B read something A had changed, and A then rolled that transaction back.
  'read-the-unreal': ({ result }) =>
    result.steps.some((s, at) =>
      s.anomalies.some((a) => a.kind === 'dirty-read' && a.against.some((other) => inside(result, at, other, 'rolled-back'))),
    ),
  // A statement was blocked, and later ran: no victim, nobody still waiting.
  'make-it-wait': ({ result }) =>
    result.steps.some((s) => s.phase === 'blocked') &&
    result.steps.some((s) => s.phase === 'resumed' && s.error === undefined) &&
    result.deadlocks === 0 &&
    result.stuck.length === 0 &&
    !result.steps.some((s) => s.phase === 'victim'),
  'pick-the-victim': ({ result }) =>
    result.deadlocks >= 1 && result.steps.some((s) => s.phase === 'victim' && s.session === 'A'),
  // A lost update was flagged on a statement of a transaction that then committed.
  'lose-an-update': ({ result }) =>
    result.steps.some(
      (s, at) => s.anomalies.some((a) => a.kind === 'lost-update') && inside(result, at, s.session, 'committed'),
    ),
  // A reader ran at once while another session held a change it had not committed, and what it was given is not what
  // that session itself sees — the reader was handed an older version.
  'read-past-the-writer': ({ result }) =>
    result.steps.some((s, at) => {
      if (s.kind !== 'statement' || s.phase !== 'ran' || s.error !== undefined || !s.run || s.run.write) return false;
      if (s.rows.length === 0 || s.anomalies.length > 0) return false;
      // The most recent record of another session is the database as that session sees it, its own changes included.
      for (let back = at - 1; back >= 0; back -= 1) {
        const other = result.steps[back]!;
        if (other.session === s.session) continue;
        const held = s.sessions.find((x) => x.session === other.session);
        if (!held || held.uncommitted === 0) return false;
        return JSON.stringify(runQuery(s.sql, other.after).rows) !== JSON.stringify(s.rows);
      }
      return false;
    }),
  // Everything that committed was committed, and no order of those transactions one at a time explains the run.
  // (Under snapshots nothing reads another's uncommitted work, so a single committed transaction is always explained.)
  'write-skew': ({ result, rows }) => {
    const check = serialCheck(result, rows);
    return !check.serializable && check.exhaustive;
  },
};

const PROTOCOL_CHECKS: Record<string, (outcomes: ProtocolOutcome[]) => boolean> = {
  'aborted-by-the-clock': (outcomes) => {
    const locking = outcomes.find((o) => o.protocol.id === 'two-phase')!;
    const timestamp = outcomes.find((o) => o.protocol.id === 'timestamp')!;
    return (
      locking.committed >= 2 &&
      locking.aborted.length === 0 &&
      locking.result.stuck.length === 0 &&
      timestamp.aborted.length >= 1
    );
  },
};

const WAL_CHECKS: Record<string, (run: WalRun) => boolean> = {
  // The rule is off, a recovery finished, and the database is not what committed.
  'ahead-of-its-log': (run) => {
    const r = lastRecovery(run);
    return r !== null && !matchesCommitted(run, r.at);
  },
  // Recovery redid a record of a transaction that had committed, and ended right.
  'redo-a-commit': (run) => {
    const r = lastRecovery(run);
    return (
      r !== null &&
      matchesCommitted(run, r.at) &&
      r.report.redo.some((x) => x.action === 'redo' && isCommittedChange(run, x.lsn))
    );
  },
  // A crash found an uncommitted change on disk, and the recovery that followed undid it.
  'undo-a-steal': (run) => {
    const r = lastRecovery(run);
    if (r === null || !matchesCommitted(run, r.at)) return false;
    const found = run.steps.some((s, at) => at < r.at && s.step.op === 'crash' && s.crash.undo.length > 0);
    return found && r.report.undo.some((u) => u.action === 'undo');
  },
  // One recovery stopped partway; a later one finished, and the database is right.
  'crash-in-recovery': (run) => {
    const stopped = run.steps.findIndex((s) => s.recovery?.interrupted === true);
    const r = lastRecovery(run);
    return stopped >= 0 && r !== null && r.at > stopped && matchesCommitted(run, r.at);
  },
  // Redo began after an update that is earlier in the log: something was written before the checkpoint.
  'start-redo-late': (run) => {
    const r = lastRecovery(run);
    const from = r?.report.analysis.redoFrom ?? null;
    if (r === null || from === null || !matchesCommitted(run, r.at)) return false;
    return run.final.log.some((l) => l.type === 'update' && l.lsn < from);
  },
  // A step that needed a frame was refused for want of one — not a page the writer was told to write.
  'no-steal-needs-a-pool': (run) =>
    run.steps.some((s) => s.error?.startsWith('No-steal') === true && s.step.op !== 'write-page'),
};

/** Every challenge id that has a check, by kind — what the tests hold against the list in `scriptChallenges.tsx`. */
export const CHECKED: Record<'schedule' | 'protocols' | 'wal', string[]> = {
  schedule: Object.keys(SCHEDULE_CHECKS),
  protocols: Object.keys(PROTOCOL_CHECKS),
  wal: Object.keys(WAL_CHECKS),
};

// — running —

const NOT_RUN: Omit<ScriptRun, 'problem'> = { passed: false, facts: [], tables: [], toolHref: null };

function lockingOf(
  setup: Extract<ScriptChallenge['setup'], { kind: 'schedule' }>,
): LockingOptions | undefined {
  if (setup.locking === 'none') return undefined;
  return {
    granularity: setup.locking === 'page' ? 'page' : 'row',
    isolation: setup.isolation ?? 'repeatable-read',
    ...(setup.locking === 'mvcc' ? { mvcc: true } : {}),
  };
}

const asLines = (steps: readonly ScheduleStep[]): ScheduleLine[] =>
  steps.map((s) => [s.session === 'B' ? 'B' : 'A', s.sql] as const);

const unique = (items: string[]): string[] => [...new Set(items)];

/** A table cell the tools' row builders made, as text: they only ever make strings and numbers. */
const asText = (cell: ReactNode): string => (typeof cell === 'string' || typeof cell === 'number' ? String(cell) : '');

export function runScript(challenge: ScriptChallenge, text: string): ScriptRun {
  const setup = challenge.setup;

  if (setup.kind === 'wal') {
    const parsed = parseWal(text);
    if (parsed.problem !== null) return { ...NOT_RUN, problem: parsed.problem };
    const run = runWal(parsed.steps, {
      frames: setup.frames,
      enforce: setup.enforce,
      steal: setup.steal,
      force: setup.force,
    });
    const check = WAL_CHECKS[challenge.id];
    if (!check) throw new Error(`script challenge ${challenge.id} has no check`);
    const recovered = lastRecovery(run);
    const crashes = run.steps.filter((s) => s.step.op === 'crash').length;
    const tables: ScriptTable[] = [
      {
        caption: 'What each step did',
        columns: ['Step', 'You wrote', 'What happened'],
        rows: run.steps.map((s) => [
          String(s.index + 1),
          formatWalStep(s.step),
          s.error ?? (s.notes.length > 0 ? s.notes.join(' ') : '—'),
        ]),
      },
    ];
    const reports = run.steps.flatMap((s) => (s.recovery ? [s.recovery] : []));
    const last = reports.at(-1);
    if (last) {
      tables.push({
        caption: reports.length > 1 ? 'The passes of the last recovery' : 'The passes of the recovery',
        columns: ['Pass', 'LSN', 'Subject', 'Action', 'Why'],
        rows: recoveryRows(last).map((r) => [r.pass, r.lsn, r.subject, r.action, r.why]),
      });
    }
    const hasCrash = parsed.steps.some((s) => s.op === 'crash' || s.op === 'recover');
    return {
      problem: null,
      passed: check(run),
      facts: [
        { label: 'records in the durable log', value: String(run.final.log.length) },
        { label: 'crashes', value: String(crashes) },
        { label: 'recoveries finished', value: String(reports.filter((r) => !r.interrupted).length) },
        {
          label: 'after the last recovery, the database is what committed',
          value: recovered === null ? 'no recovery has finished' : matchesCommitted(run, recovered.at) ? 'yes' : 'no',
        },
      ],
      tables,
      toolHref: scenarioHref({
        tool: hasCrash ? 'recovery' : 'wal',
        lines: parsed.steps.map(formatWalStep),
        frames: setup.frames,
        enforce: setup.enforce,
        steal: setup.steal,
        force: setup.force,
      }),
    };
  }

  const parsed = parseSchedule(text);
  if (parsed.problem !== null) return { ...NOT_RUN, problem: parsed.problem };

  if (setup.kind === 'protocols') {
    const check = PROTOCOL_CHECKS[challenge.id];
    if (!check) throw new Error(`script challenge ${challenge.id} has no check`);
    const outcomes = compareProtocols(parsed.steps, setup.rows);
    return {
      problem: null,
      passed: check(outcomes),
      facts: [],
      tables: [
        {
          caption: 'The same schedule under each protocol',
          columns: ['Protocol', 'Committed', 'Ended by the protocol', 'Waits', 'Anomalies let through', 'Serializable'],
          rows: outcomes.map((o) => [
            o.protocol.label,
            String(o.committed),
            o.aborted.length === 0 ? 'none' : o.aborted.map((t) => t.session).join(', '),
            String(o.waits),
            o.anomalies.length === 0 ? 'none' : o.anomalies.join(', '),
            o.serializable ? 'yes' : o.check.exhaustive ? 'no' : 'no order found',
          ]),
        },
      ],
      toolHref: scenarioHref({ tool: 'concurrency', lines: asLines(parsed.steps), rows: setup.rows }),
    };
  }

  const check = SCHEDULE_CHECKS[challenge.id];
  if (!check) throw new Error(`script challenge ${challenge.id} has no check`);
  const result = runSchedule(parsed.steps, createAccountsDatabase(setup.rows), undefined, lockingOf(setup));
  const anomalies = unique(result.steps.flatMap((s) => s.anomalies.map((a) => a.kind)));
  return {
    problem: null,
    passed: check({ result, rows: setup.rows }),
    facts: [
      { label: 'statements that had to wait', value: String(result.steps.filter((s) => s.phase === 'blocked').length) },
      { label: 'rolled back by the engine', value: String(result.steps.filter((s) => s.phase === 'victim').length) },
      { label: 'deadlocks', value: String(result.deadlocks) },
      { label: 'anomalies flagged', value: anomalies.length === 0 ? 'none' : anomalies.join(', ') },
    ],
    tables: [
      {
        caption: 'What each step did',
        columns: SCHEDULE_COLUMNS.map((c) => c.header),
        rows: scheduleRows(result.steps).map((row) => SCHEDULE_COLUMNS.map((c) => asText(c.cell(row)))),
      },
    ],
    toolHref: scenarioHref({
      tool: 'schedule',
      lines: asLines(parsed.steps),
      locking: setup.locking,
      rows: setup.rows,
      ...(setup.isolation !== undefined ? { isolation: setup.isolation } : {}),
    }),
  };
}
