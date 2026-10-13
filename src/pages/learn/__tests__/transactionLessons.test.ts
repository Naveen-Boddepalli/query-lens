import { describe, expect, it } from 'vitest';
import { compareProtocols } from '../../../engine/concurrencyCompare.ts';
import type { ProtocolId } from '../../../engine/concurrencyCompare.ts';
import { DOCUMENTED, KNOWN_DIFFERENCES, hermitageMatrix } from '../../../engine/hermitage.ts';
import type { EngineKind } from '../../../engine/hermitage.ts';
import { databaseFromCells } from '../../../engine/recovery/heap.ts';
import { DEFAULT_PAGES, committedCells, databaseCells, parseWalStep, runWal } from '../../../engine/recovery/wal.ts';
import type { WalRun } from '../../../engine/recovery/wal.ts';
import { runQuery } from '../../../engine/runQuery.ts';
import { runSchedule } from '../../../engine/schedule.ts';
import type { LockingOptions, ScheduleResult, ScheduleStepResult } from '../../../engine/schedule.ts';
import { createAccountsDatabase, createSeedDatabase } from '../../../engine/index.ts';
import { serialCheck } from '../../../engine/serialCheck.ts';
import type { IsolationLevel } from '../../../engine/transactionControl.ts';
import { LOG_MAX_STEPS, appendStep, openLog, recordWrite } from '../../../ui/durableLog.ts';
import { decodeSchedule } from '../../../ui/scheduleUrl.ts';
import { decodeWalSteps } from '../../../ui/walUrl.ts';
import { LESSONS, PIPELINE_LESSONS } from '../lessons.tsx';
import { TRANSACTION_LESSONS } from '../transactionLessons.tsx';
import { SCENARIOS, scenarioHref } from '../transactionScenarios.ts';
import type { ConcurrencyScenario, Scenario, ScheduleScenario, WalScenario } from '../transactionScenarios.ts';

/**
 * A lesson's tool link is only as good as the run behind it. Each scenario here is run on the real engine and held to
 * the sentence its lesson says about it, so an engine change that makes a lesson untrue fails here and not in front of
 * a learner. The prose is copy; these numbers are not.
 */

/** The options the schedule tool builds from its `l` and `i` parameters. */
function lockingOf(s: ScheduleScenario, isolation: IsolationLevel | undefined = s.isolation): LockingOptions | undefined {
  if (s.locking === 'none') return undefined;
  return {
    granularity: s.locking === 'page' ? 'page' : 'row',
    isolation: isolation ?? 'repeatable-read',
    ...(s.locking === 'mvcc' ? { mvcc: true } : {}),
  };
}

function schedule(s: ScheduleScenario, isolation?: IsolationLevel): ScheduleResult {
  return runSchedule(
    s.lines.map(([session, sql]) => ({ session, sql })),
    createAccountsDatabase(s.rows),
    undefined,
    lockingOf(s, isolation),
  );
}

/** The record for input step `index` (zero-based), by phase: a blocked statement leaves two. */
function record(result: ScheduleResult, index: number, phase: ScheduleStepResult['phase'] = 'ran'): ScheduleStepResult {
  const found = result.steps.find((s) => s.index === index && s.phase === phase);
  if (!found) throw new Error(`no ${phase} record for step ${String(index)}`);
  return found;
}

const balances = (r: ScheduleStepResult): unknown[] => r.rows.map((row) => row.balance);
const kinds = (r: ScheduleResult): string[] => r.steps.flatMap((s) => s.anomalies.map((a) => a.kind));

function wal(s: WalScenario, over: Partial<WalScenario> = {}): WalRun {
  const o = { ...s, ...over };
  return runWal(o.lines.map((l) => parseWalStep(l)!), {
    frames: o.frames ?? 3,
    enforce: o.enforce ?? true,
    steal: o.steal ?? true,
    force: o.force ?? false,
  });
}

const recoveries = (run: WalRun) => run.steps.flatMap((s) => (s.recovery ? [s.recovery] : []));

function outcome(s: ConcurrencyScenario, id: ProtocolId) {
  const all = compareProtocols(
    s.lines.map(([session, sql]) => ({ session, sql })),
    s.rows,
  );
  return all.find((o) => o.protocol.id === id)!;
}

describe('the transaction lessons are wired into the track', () => {
  it('come last in the track, with unique ids', () => {
    // The transactions group is last in the track; the lessons before it are checked in `storageLessons.test.ts`.
    expect(LESSONS.slice(-TRANSACTION_LESSONS.length)).toEqual(TRANSACTION_LESSONS);
    expect(LESSONS.slice(0, PIPELINE_LESSONS.length)).toEqual(PIPELINE_LESSONS);
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TRANSACTION_LESSONS.length).toBe(7);
  });

  it('every tool link is a scenario, and every scenario but the named variants has a lesson', () => {
    const used = new Set<string>();
    for (const lesson of TRANSACTION_LESSONS) {
      for (const [i, step] of lesson.steps.entries()) {
        if (step.link) used.add(step.link.href);
        else expect(step.open, `${lesson.id} step ${String(i + 1)} has neither a tool nor a Playground link`).toBeTruthy();
      }
    }
    const byHref = new Map(
      Object.entries(SCENARIOS).map(([name, s]) => [scenarioHref(s as Scenario), name] as const),
    );
    for (const href of used) expect(byHref.has(href), `a lesson links ${href}, which is not a scenario`).toBe(true);
    // Run for a sentence in a "try this", not a button of its own.
    const variants = ['nonRepeatableReadHeld', 'phantomSerializable'];
    const unlinked = Object.keys(SCENARIOS).filter((name) => !used.has(scenarioHref(SCENARIOS[name as keyof typeof SCENARIOS] as Scenario)));
    expect(unlinked.sort()).toEqual(variants.sort());
  });

  it('every link opens a tool with the script it names, in the tool’s own URL scheme', () => {
    for (const s of Object.values(SCENARIOS) as Scenario[]) {
      const url = new URL(scenarioHref(s), 'https://x');
      expect(url.pathname).toBe(`/tools/${s.tool}`);
      if (s.tool === 'isolation') continue;
      if (s.tool === 'schedule' || s.tool === 'concurrency') {
        const steps = decodeSchedule(url.searchParams.get('s'));
        expect(steps?.map((x) => [x.session, x.sql])).toEqual(s.lines.map((l) => [...l]));
        expect(url.searchParams.get('n')).toBe(String(s.rows));
      } else {
        const steps = decodeWalSteps(url.searchParams.get('s'));
        expect(steps).toEqual(s.lines.map((l) => parseWalStep(l)));
        expect(url.searchParams.get('e') === '0').toBe(s.enforce === false);
        expect(url.searchParams.get('st') === '0').toBe(s.steal === false);
        expect(url.searchParams.get('fo') === '1').toBe(s.force === true);
      }
    }
  });
});

describe('lesson: let a dirty read happen, then stop it', () => {
  it('with no locks, B reads 0, the run flags it, and the next read shows 100', () => {
    const r = schedule(SCENARIOS.dirtyRead);
    expect(balances(record(r, 2))).toEqual([0]);
    expect(record(r, 2).anomalies.map((a) => [a.kind, a.against])).toEqual([['dirty-read', ['A']]]);
    expect(balances(record(r, 4))).toEqual([100]);
  });

  it('under row locks B waits on A, then reads 100, and nothing is flagged', () => {
    const r = schedule(SCENARIOS.dirtyReadLocked);
    expect(record(r, 2, 'blocked').waitingOn).toEqual(['A']);
    expect(balances(record(r, 2, 'resumed'))).toEqual([100]);
    expect(kinds(r)).toEqual([]);
  });

  it('a deadlock rolls back B, because B made its first lock request most recently', () => {
    const r = schedule(SCENARIOS.deadlock);
    expect(r.deadlocks).toBe(1);
    const victim = r.steps.find((s) => s.phase === 'victim')!;
    expect(victim.session).toBe('B');
    expect(victim.notes.join(' ')).toContain('arrived most recently');
    expect(record(r, 6).kind).toBe('commit');
  });

  it('and with B asking first (the try-this), BEGIN does not count: A is rolled back', () => {
    const lines = [...SCENARIOS.deadlock.lines];
    // Move B's UPDATE of id 2 above A's UPDATE of id 1; both still BEGIN in the same order.
    [lines[2], lines[3]] = [lines[3]!, lines[2]!];
    const r = runSchedule(
      lines.map(([session, sql]) => ({ session, sql })),
      createAccountsDatabase(20),
      undefined,
      lockingOf(SCENARIOS.deadlock),
    );
    expect(r.deadlocks).toBe(1);
    expect(r.steps.find((s) => s.phase === 'victim')!.session).toBe('A');
  });
});

describe('lesson: read the isolation matrix', () => {
  it('has 80 cells, and exactly one of them disagrees with the published results', () => {
    let cells = 0;
    let disagree = 0;
    for (const engine of ['locks', 'mvcc'] as EngineKind[]) {
      for (const cell of hermitageMatrix(engine)) {
        cells += 1;
        if (cell.occurred !== DOCUMENTED[engine][cell.level][cell.test]) disagree += 1;
      }
    }
    expect(cells).toBe(80);
    expect(disagree).toBe(1);
    expect(KNOWN_DIFFERENCES).toHaveLength(1);
  });

  it('at READ COMMITTED the second read is 50 and is flagged; at REPEATABLE READ B waits and A reads 100 twice', () => {
    const rc = schedule(SCENARIOS.nonRepeatableRead);
    expect(balances(record(rc, 1))).toEqual([100]);
    expect(balances(record(rc, 3))).toEqual([50]);
    expect(kinds(rc)).toEqual(['non-repeatable-read']);

    const rr = schedule(SCENARIOS.nonRepeatableReadHeld);
    expect(record(rr, 2, 'blocked').waitingOn).toEqual(['A']);
    expect(balances(record(rr, 1))).toEqual([100]);
    expect(balances(record(rr, 3))).toEqual([100]);
    expect(kinds(rr)).toEqual([]);
  });

  it('at REPEATABLE READ the second read has an extra row and is flagged a phantom; at SERIALIZABLE B waits', () => {
    const rr = schedule(SCENARIOS.phantom);
    expect(record(rr, 1).rows).toHaveLength(20);
    expect(record(rr, 3).rows).toHaveLength(21);
    expect(kinds(rr)).toEqual(['phantom']);

    const ser = schedule(SCENARIOS.phantomSerializable);
    expect(record(ser, 2, 'blocked').waitingOn).toEqual(['A']);
    expect(record(ser, 3).rows).toHaveLength(20);
    expect(record(ser, 2, 'resumed').error).toBeUndefined();
    expect(kinds(ser)).toEqual([]);
  });
});

describe('lesson: readers that never wait', () => {
  it('a snapshot read stays at 100 after B commits 50, takes no lock and waits for nothing', () => {
    const r = schedule(SCENARIOS.snapshotRead);
    expect(r.steps.every((s) => s.phase === 'ran')).toBe(true);
    expect(balances(record(r, 1))).toEqual([100]);
    expect(balances(record(r, 3))).toEqual([100]);
    expect(kinds(r)).toEqual([]);
    expect(r.committed.tables.accounts!.rows.find((row) => row.id === 1)!.balance).toBe(50);
  });

  it('first committer wins: A is rolled back with a serialization failure at its UPDATE', () => {
    const r = schedule(SCENARIOS.firstCommitterWins);
    expect(record(r, 4).kind).toBe('commit');
    const victim = record(r, 5, 'victim');
    expect(victim.session).toBe('A');
    expect(victim.error).toMatch(/serialize/i);
  });

  it('write skew: both commit and no one-at-a-time order explains what they read; SERIALIZABLE refuses the second commit', () => {
    const r = schedule(SCENARIOS.writeSkew);
    expect(r.steps.filter((s) => s.phase === 'victim')).toHaveLength(0);
    const check = serialCheck(r, 20);
    expect(check.serializable).toBe(false);
    expect(check.exhaustive).toBe(true);

    const strict = schedule(SCENARIOS.writeSkew, 'serializable');
    const refused = record(strict, 7, 'victim');
    expect(refused.session).toBe('B');
    expect(refused.kind).toBe('commit');
  });

  it('three updates and one rollback leave four dead versions: six pages, five after VACUUM', () => {
    expect(schedule(SCENARIOS.deadTuples).bloat).toEqual({ dead: 4, pages: 6, pagesAfterVacuum: 5 });
  });
});

describe('lesson: locks, timestamps or optimism?', () => {
  it('the lost update: 2PL waits once and commits both; timestamps abort A at its UPDATE; optimism refuses A at COMMIT', () => {
    const s = SCENARIOS.protocolsLostUpdate;
    const twoPhase = outcome(s, 'two-phase');
    expect([twoPhase.committed, twoPhase.waits, twoPhase.aborted.length, twoPhase.wasted]).toEqual([2, 1, 0, 0]);

    const timestamp = outcome(s, 'timestamp');
    expect(timestamp.waits).toBe(0);
    expect(timestamp.aborted.map((t) => t.session)).toEqual(['A']);
    expect(timestamp.result.steps.find((x) => x.phase === 'victim')!.kind).toBe('statement');

    const optimistic = outcome(s, 'optimistic');
    expect(optimistic.aborted.map((t) => t.session)).toEqual(['A']);
    expect(optimistic.result.steps.find((x) => x.phase === 'victim')!.kind).toBe('commit');
    expect(optimistic.wasted).toBeGreaterThan(timestamp.wasted);

    for (const id of ['snapshot', 'serializable-snapshot'] as const) {
      const o = outcome(s, id);
      expect(o.aborted.map((t) => t.session)).toEqual(['A']);
      expect(o.result.steps.find((x) => x.phase === 'victim')!.error).toMatch(/concurrent update/);
    }
    for (const id of ['two-phase', 'timestamp', 'optimistic', 'snapshot', 'serializable-snapshot'] as const) {
      expect(outcome(s, id).serializable, id).toBe(true);
    }
  });

  it('write skew: snapshots commit both, with nothing waited for or thrown away, and are not serializable; the rest end one', () => {
    const s = SCENARIOS.protocolsWriteSkew;
    const snapshot = outcome(s, 'snapshot');
    expect([snapshot.committed, snapshot.waits, snapshot.aborted.length]).toEqual([2, 0, 0]);
    expect(snapshot.serializable).toBe(false);
    expect(snapshot.check.exhaustive).toBe(true);
    for (const id of ['two-phase', 'timestamp', 'optimistic', 'serializable-snapshot'] as const) {
      const o = outcome(s, id);
      expect(o.aborted, id).toHaveLength(1);
      expect(o.serializable, id).toBe(true);
    }
  });

  it('a non-repeatable read: three of the five end A, snapshots commit both, and all five are serializable', () => {
    const s = SCENARIOS.protocolsNonRepeatable;
    const ids: ProtocolId[] = ['two-phase', 'timestamp', 'optimistic', 'snapshot', 'serializable-snapshot'];
    const ended = ids.filter((id) => outcome(s, id).aborted.some((t) => t.session === 'A'));
    expect(ended.sort()).toEqual(['optimistic', 'serializable-snapshot', 'timestamp']);
    expect(outcome(s, 'snapshot').committed).toBe(2);
    for (const id of ids) expect(outcome(s, id).serializable, id).toBe(true);
  });
});

describe('lesson: why the log goes first', () => {
  it('forces the log through the change before the page is written', () => {
    const run = wal(SCENARIOS.ruleEnforced);
    const write = run.steps[2]!;
    expect(write.effects.map((e) => e.kind)).toEqual(['log-flush', 'page-write']);
    expect(write.effects[0]).toMatchObject({ kind: 'log-flush', reason: 'log-before-data' });
    expect(run.steps.every((r) => r.violations.length === 0)).toBe(true);
  });

  it('with the rule off a crash loses the record and recovery leaves 99 where 10 was committed', () => {
    const run = wal(SCENARIOS.ruleOff);
    expect(run.steps[2]!.effects.some((e) => e.kind === 'rule-violated')).toBe(true);
    const [report] = recoveries(run);
    expect(report!.analysis.losers).toEqual([]);
    expect(report!.undo.some((u) => u.action === 'undo')).toBe(false);
    expect(databaseCells(run.final).a).toBe(99);
    expect(committedCells(run.final, DEFAULT_PAGES).a).toBe(10);
  });

  it('a commit forces the log and writes no page, so one committed change is not yet on disk', () => {
    const run = wal(SCENARIOS.commitIsALogWrite);
    const commit = run.steps[2]!;
    expect(commit.effects.some((e) => e.kind === 'log-flush' && e.reason === 'commit')).toBe(true);
    expect(commit.effects.some((e) => e.kind === 'page-write')).toBe(false);
    expect(commit.crash.redo).toHaveLength(1);
    expect(commit.state.pool.find((f) => f?.page === 1)?.recLSN).not.toBeNull();
  });
});

describe('lesson: steal and force', () => {
  it('no-force: the commit writes no page and a crash would owe three redos; force writes three pages and owes none', () => {
    const noForce = wal(SCENARIOS.noForce).steps.at(-1)!;
    expect(noForce.effects.filter((e) => e.kind === 'page-write')).toHaveLength(0);
    expect(noForce.crash.redo).toHaveLength(3);

    const forced = wal(SCENARIOS.force).steps.at(-1)!;
    const writes = forced.effects.filter((e) => e.kind === 'page-write');
    expect(writes).toHaveLength(3);
    expect(writes.every((e) => e.kind === 'page-write' && e.reason === 'force')).toBe(true);
    expect(forced.crash.redo).toHaveLength(0);
  });

  it('steal: reading page 3 evicts T1’s dirty page 1, and a crash would owe an undo', () => {
    const step = wal(SCENARIOS.steal).steps[3]!;
    expect(step.effects.find((e) => e.kind === 'page-evict')).toMatchObject({ page: 1, dirty: true });
    expect(step.crash.undo.map((c) => [c.page, c.key, c.by])).toEqual([[1, 'a', 'T1']]);
  });

  it('no-steal: the third page has no frame, the step is refused, and nothing uncommitted is on disk', () => {
    const step = wal(SCENARIOS.noSteal).steps.at(-1)!;
    expect(step.error).toMatch(/^No-steal/);
    expect(step.crash.undo).toHaveLength(0);
  });
});

describe('lesson: survive a crash', () => {
  it('analysis names T2 the loser; redo puts back T1’s change and T2’s second, skips T2’s first; undo takes T2 out newest first', () => {
    const run = wal(SCENARIOS.bothAtOnce);
    const [report] = recoveries(run);
    expect(report!.analysis.losers).toEqual(['T2']);
    expect(report!.redo.map((r) => `${r.action}:${r.key}`)).toEqual(['redo:a', 'skip:c', 'redo:g']);
    expect(report!.undo.filter((u) => u.action === 'undo').map((u) => u.lsn)).toEqual([3, 2]);
    expect(databaseCells(run.final)).toEqual(committedCells(run.final, DEFAULT_PAGES));
  });

  it('a checkpoint after the pages were written moves redo to T2’s own change; without those writes it moves nothing', () => {
    const run = wal(SCENARIOS.checkpoint);
    const [report] = recoveries(run);
    expect(report!.analysis.checkpoint).not.toBeNull();
    expect(report!.analysis.from).toBe(report!.analysis.checkpoint);
    const firstUpdate = run.final.log.find((r) => r.type === 'update')!.lsn;
    expect(report!.analysis.redoFrom!).toBeGreaterThan(firstUpdate);

    const unwritten = wal(SCENARIOS.checkpoint, {
      lines: SCENARIOS.checkpoint.lines.filter((l) => !l.startsWith('write page')),
    });
    const [again] = recoveries(unwritten);
    expect(again!.analysis.checkpoint).not.toBeNull();
    expect(again!.analysis.redoFrom).toBe(1);
  });

  it('a crash during recovery: the second restart follows the compensation records and undoes only what is left', () => {
    const run = wal(SCENARIOS.crashDuringRecovery);
    const [first, second] = recoveries(run);
    expect(first!.interrupted).toBe(true);
    expect(second!.interrupted).toBe(false);
    expect(second!.undo.some((u) => u.action === 'follow')).toBe(true);
    const undone = (r: typeof first) => r!.undo.filter((u) => u.action === 'undo').map((u) => u.lsn);
    expect(undone(first).filter((lsn) => undone(second).includes(lsn))).toEqual([]);
    expect(undone(first).length + undone(second).length).toBe(3);
    expect(databaseCells(run.final)).toEqual(committedCells(run.final, DEFAULT_PAGES));
  });

  it('behind a real UPDATE: committed and crashed, the edit is back; left open and crashed, it is gone', () => {
    const sql = "UPDATE users SET name = 'edited' WHERE id = 5;";
    const db = createSeedDatabase();
    const result = runQuery(sql, db);
    expect(result.write).toBeDefined();
    const log = recordWrite(openLog(db, 4), db, sql, {
      table: result.write!.table,
      kind: result.write!.kind,
      rows: result.write!.rows,
    });
    const nameAfter = (finishWith: 'commit' | 'open'): unknown => {
      let l = log;
      if (finishWith === 'commit') l = appendStep(l, { op: 'commit', txn: 'Q1' });
      l = appendStep(l, { op: 'crash' });
      l = appendStep(l, { op: 'recover' });
      const run = runWal(l.steps, { pages: l.pages, frames: 4, maxSteps: LOG_MAX_STEPS });
      const recovered = databaseFromCells(l.base, l.heap, databaseCells(run.final));
      return recovered.tables.users!.rows.find((row) => row.id === 5)!.name;
    };
    expect(nameAfter('commit')).toBe('edited');
    expect(nameAfter('open')).not.toBe('edited');
  });
});
