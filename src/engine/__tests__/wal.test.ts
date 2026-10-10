import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGES,
  MAX_WAL_STEPS,
  comparePolicies,
  formatWalStep,
  parseWalStep,
  runWal,
  walViolations,
} from '../recovery/wal.ts';
import { isTxnRecord } from '../recovery/wal.ts';
import type { Cell, LogRecord, TxnRecord, WalState, WalStep } from '../recovery/wal.ts';

const script = (...lines: string[]): WalStep[] =>
  lines.map((l) => {
    const step = parseWalStep(l);
    if (!step) throw new Error(`not a step: ${l}`);
    return step;
  });

const last = (run: ReturnType<typeof runWal>) => run.final;
const allRecords = (s: WalState): TxnRecord[] => [...s.log, ...s.logBuffer].filter(isTxnRecord);

describe('parsing', () => {
  it('reads each step and writes it back the same way', () => {
    for (const text of [
      'begin T1',
      'set T1 a = 99',
      'commit T1',
      'abort T1',
      'flush log',
      'write page 2',
      'read page 3',
    ]) {
      const step = parseWalStep(text);
      expect(step).not.toBeNull();
      expect(formatWalStep(step!)).toBe(text);
    }
  });

  it('is forgiving about spacing and case, and calls rollback abort', () => {
    expect(parseWalStep('  SET   T2  b=5 ')).toEqual({ op: 'set', txn: 'T2', key: 'b', value: 5 });
    expect(parseWalStep('rollback T1')).toEqual({ op: 'abort', txn: 'T1' });
    expect(parseWalStep('set T1 a = -3')).toEqual({ op: 'set', txn: 'T1', key: 'a', value: -3 });
  });

  it('refuses what is not a step', () => {
    for (const text of ['', 'begin', 'set T1 a', 'set T1 1 = 5', 'drop table', 'write page x', 'commit T1 now']) {
      expect(parseWalStep(text)).toBeNull();
    }
  });
});

describe('the log', () => {
  it('numbers records from 1 and chains each transaction’s records by prevLSN', () => {
    const run = runWal(script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 c = 2', 'set T1 b = 3', 'commit T1'));
    const records = allRecords(last(run));
    expect(records.map((r) => r.lsn)).toEqual([1, 2, 3, 4, 5]);
    expect(records.map((r) => `${r.txn}:${r.type}:${String(r.prevLSN)}`)).toEqual([
      'T1:update:null',
      'T2:update:null',
      'T1:update:1',
      'T1:commit:3',
      'T1:end:4',
    ]);
  });

  it('keeps a change in the log buffer and the pool, and nowhere durable, until something forces it', () => {
    const run = runWal(script('begin T1', 'set T1 a = 99'));
    const s = last(run);
    expect(s.logBuffer).toHaveLength(1);
    expect(s.log).toEqual([]);
    expect(s.flushedLSN).toBe(0);
    expect(s.pool.find((f) => f?.page === 1)).toMatchObject({ pageLSN: 1, recLSN: 1, cells: { a: 99, b: 20 } });
    expect(s.disk.find((p) => p.page === 1)).toMatchObject({ pageLSN: 0, cells: { a: 10, b: 20 } });
  });

  it('remembers where a page first became dirty, and the last change made to it', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'set T1 b = 2', 'write page 1', 'set T1 a = 3'));
    const frame = (i: number) => run.steps[i]!.state.pool.find((f) => f?.page === 1)!;
    // Two changes: dirtied at LSN 1, last changed at LSN 2.
    expect(frame(2)).toMatchObject({ recLSN: 1, pageLSN: 2 });
    // Written: clean, with the pageLSN the disk now has.
    expect(frame(3)).toMatchObject({ recLSN: null, pageLSN: 2 });
    // Dirtied again: the first change since the write, which is LSN 3.
    expect(frame(4)).toMatchObject({ recLSN: 3, pageLSN: 3 });
  });

  it('a page that has been written is clean, so writing it again is a no-op', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1', 'write page 1'));
    expect(run.steps[3]!.effects).toEqual([]);
    expect(run.steps[3]!.notes[0]).toContain('clean');
  });

  it('lets go of what a committed transaction held', () => {
    const run = runWal(script('begin T1', 'begin T2', 'set T1 a = 1', 'commit T1', 'set T2 a = 2'));
    expect(run.steps[4]!.error).toBeUndefined();
    expect(last(run).pool.find((f) => f?.page === 1)!.cells.a).toBe(2);
  });

  it('forces the log at commit, through the commit record, and writes no data page', () => {
    const run = runWal(script('begin T1', 'set T1 a = 99', 'set T1 c = 5', 'commit T1'));
    const commit = run.steps[3]!;
    expect(commit.effects.filter((e) => e.kind === 'log-flush')).toEqual([
      { kind: 'log-flush', from: 1, to: 3, reason: 'commit' },
    ]);
    expect(commit.effects.some((e) => e.kind === 'page-write')).toBe(false);
    const s = last(run);
    expect(s.flushedLSN).toBe(3);
    // The end record is written after the force and is not itself durable yet.
    expect(s.logBuffer.map((r) => r.type)).toEqual(['end']);
    expect(s.disk.every((p) => p.pageLSN === 0)).toBe(true);
  });

  it('a transaction that changed nothing commits without touching the log', () => {
    const run = runWal(script('begin T1', 'commit T1'));
    expect(allRecords(last(run))).toEqual([]);
    expect(run.steps[1]!.notes[0]).toContain('nothing to make durable');
  });
});

describe('log before data', () => {
  it('flushes the log through the page’s LSN, and only that far, before writing the page', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 e = 3', 'write page 2'));
    const step = run.steps[4]!;
    // Page 2 holds c, changed at LSN 2. The log is forced through 2; LSN 3 stays in the buffer.
    expect(step.effects.map((e) => e.kind)).toEqual(['log-flush', 'page-write']);
    expect(step.effects[0]).toEqual({ kind: 'log-flush', from: 1, to: 2, reason: 'log-before-data' });
    const s = last(run);
    expect(s.flushedLSN).toBe(2);
    expect(s.logBuffer.map((r) => r.lsn)).toEqual([3]);
    expect(s.disk.find((p) => p.page === 2)).toMatchObject({ pageLSN: 2, cells: { c: 2, d: 40 } });
    expect(step.violations).toEqual([]);
  });

  it('does not flush when the log is already durable far enough', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'flush log', 'write page 1'));
    expect(run.steps[3]!.effects.map((e) => e.kind)).toEqual(['page-write']);
  });

  it('writes a dirty page back, log first, when the pool needs its frame', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'read page 2', 'read page 3'), { frames: 2 });
    // Page 1 is the least recently used and dirty: evicted, its log forced, then written.
    const step = run.steps[3]!;
    expect(step.effects.map((e) => e.kind)).toEqual(['page-evict', 'log-flush', 'page-write', 'page-fetch']);
    expect(step.effects[0]).toMatchObject({ kind: 'page-evict', page: 1, dirty: true });
    expect(step.effects[2]).toMatchObject({ kind: 'page-write', page: 1, reason: 'eviction' });
    expect(last(run).disk.find((p) => p.page === 1)).toMatchObject({ pageLSN: 1, cells: { a: 1, b: 20 } });
  });

  it('drops a clean page without a write', () => {
    const run = runWal(script('read page 1', 'read page 2', 'read page 3'), { frames: 2 });
    const step = run.steps[2]!;
    expect(step.effects.map((e) => e.kind)).toEqual(['page-evict', 'page-fetch']);
    expect(step.effects[0]).toMatchObject({ dirty: false });
  });

  it('with the rule off, writes the page ahead of its log and says what that costs', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { enforce: false });
    const step = run.steps[2]!;
    expect(step.effects.map((e) => e.kind)).toEqual(['rule-violated', 'page-write']);
    expect(step.violations).toHaveLength(1);
    expect(step.violations[0]).toContain('Page 1 on disk');
    expect(last(run).flushedLSN).toBe(0);
    expect(walViolations(last(run))).toHaveLength(1);
  });

  it('the same script with the rule on is clean', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { enforce: true });
    expect(run.steps.every((s) => s.violations.length === 0)).toBe(true);
  });
});

describe('rolling back', () => {
  const rolled = () =>
    runWal(script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 a = 3', 'abort T1'));

  it('undoes newest first, logging a compensation record for each', () => {
    const s = last(rolled());
    const records = allRecords(s);
    expect(records.map((r) => r.type)).toEqual(['update', 'update', 'update', 'abort', 'clr', 'clr', 'clr', 'end']);
    const clrs = records.filter((r): r is Extract<LogRecord, { type: 'clr' }> => r.type === 'clr');
    // LSN 3 (a: 1 → 3) is undone first, then LSN 2 (c), then LSN 1 (a).
    expect(clrs.map((c) => `${c.key}=${String(c.after)}`)).toEqual(['a=1', 'c=30', 'a=10']);
    expect(clrs.map((c) => c.undoNextLSN)).toEqual([2, 1, null]);
  });

  it('puts every value back, and the transaction can no longer be used', () => {
    const run = rolled();
    const s = last(run);
    const value = (page: number, key: string) => s.pool.find((f) => f?.page === page)!.cells[key];
    expect(value(1, 'a')).toBe(10);
    expect(value(2, 'c')).toBe(30);
    expect(s.txns[0]).toMatchObject({ txn: 'T1', status: 'ended', outcome: 'rolled-back' });
    const again = runWal([...run.steps.map((r) => r.step), { op: 'set', txn: 'T1', key: 'a', value: 5 }]);
    expect(again.steps.at(-1)!.error).toContain('already rolled back');
  });

  it('releases what the transaction held', () => {
    const run = runWal(script('begin T1', 'begin T2', 'set T1 a = 1', 'abort T1', 'set T2 a = 2'));
    expect(run.steps[4]!.error).toBeUndefined();
    expect(last(run).pool.find((f) => f?.page === 1)!.cells.a).toBe(2);
  });
});

describe('refusals', () => {
  const refused = (lines: string[], options?: Parameters<typeof runWal>[1]) => {
    const run = runWal(script(...lines), options);
    const step = run.steps.at(-1)!;
    const before = run.steps.at(-2)?.state ?? run.initial;
    return { step, before };
  };

  it('an unknown transaction, cell or page changes nothing', () => {
    for (const [lines, text] of [
      [['set T9 a = 1'], 'has not begun'],
      [['begin T1', 'set T1 zz = 1'], 'no cell named zz'],
      [['read page 9'], 'no page 9'],
      [['write page 9'], 'no page 9'],
      [['begin T1', 'begin T1'], 'already exists'],
      [['begin T1', 'commit T1', 'commit T1'], 'already committed'],
    ] as [string[], string][]) {
      const { step, before } = refused(lines);
      expect(step.error).toContain(text);
      expect(step.state).toEqual(before);
      expect(step.effects).toEqual([]);
    }
  });

  it('a cell another live transaction has changed is its alone until it ends', () => {
    const { step, before } = refused(['begin T1', 'begin T2', 'set T1 a = 1', 'set T2 a = 2']);
    expect(step.error).toContain("T1's until it does");
    expect(step.state).toEqual(before);
  });

  it('writing a page that is not resident or not dirty is a note, not an error', () => {
    const { step } = refused(['write page 1']);
    expect(step.error).toBeUndefined();
    expect(step.notes[0]).toContain('not in the pool');
    const clean = refused(['read page 1', 'write page 1']).step;
    expect(clean.notes[0]).toContain('clean');
  });

  it('stops at the step limit and says so', () => {
    const many = Array.from({ length: MAX_WAL_STEPS + 5 }, (): WalStep => ({ op: 'flush-log' }));
    const run = runWal(many);
    expect(run.steps).toHaveLength(MAX_WAL_STEPS);
    expect(run.truncated).toBe(true);
  });
});

describe('whatever the script', () => {
  const key = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const txn = fc.constantFrom('T1', 'T2', 'T3');
  const step: fc.Arbitrary<WalStep> = fc.oneof(
    txn.map((t): WalStep => ({ op: 'begin', txn: t })),
    fc
      .record({ txn, key, value: fc.integer({ min: 0, max: 99 }) })
      .map(({ txn: t, key: k, value }): WalStep => ({ op: 'set', txn: t, key: k, value })),
    txn.map((t): WalStep => ({ op: 'commit', txn: t })),
    txn.map((t): WalStep => ({ op: 'abort', txn: t })),
    fc.constant<WalStep>({ op: 'flush-log' }),
    fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'write-page', page })),
    fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'read-page', page })),
  );
  const scripts = fc.array(step, { maxLength: 30 });
  const frames = fc.integer({ min: 1, max: 4 });
  const policy = fc.record({ steal: fc.boolean(), force: fc.boolean() });

  it('with the rule enforced, no page on disk is ever ahead of the durable log', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const run = runWal(steps, { frames: n, ...p });
        for (const r of run.steps) {
          expect(r.violations).toEqual([]);
          for (const p of r.state.disk) expect(p.pageLSN).toBeLessThanOrEqual(r.state.flushedLSN);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('the durable log is a gapless prefix and the buffer carries on from it', () => {
    fc.assert(
      fc.property(scripts, frames, fc.boolean(), policy, (steps, n, enforce, p) => {
        const run = runWal(steps, { frames: n, enforce, ...p });
        for (const r of run.steps) {
          const s = r.state;
          const lsns = [...s.log, ...s.logBuffer].map((x) => x.lsn);
          expect(lsns).toEqual(lsns.map((_, i) => i + 1));
          expect(s.log.length).toBe(s.flushedLSN);
          expect(s.nextLSN).toBe(lsns.length + 1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a commit is durable the moment it returns', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const run = runWal(steps, { frames: n, ...p });
        for (const r of run.steps) {
          if (r.step.op !== 'commit' || r.error !== undefined) continue;
          const commit = r.state.log.find((x) => x.type === 'commit' && x.txn === (r.step as { txn: string }).txn);
          const wroteAnything = r.state.log.some((x) => x.type === 'update' && x.txn === (r.step as { txn: string }).txn);
          if (wroteAnything) expect(commit).toBeDefined();
        }
      }),
      { numRuns: 300 },
    );
  });

  it('each transaction’s records chain back through prevLSN, strictly downwards, to its first', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const s = runWal(steps, { frames: n, ...p }).final;
        const records = allRecords(s);
        const byLsn = new Map(records.map((r) => [r.lsn, r]));
        for (const t of s.txns) {
          const mine = records.filter((r) => r.txn === t.txn);
          if (mine.length === 0) {
            expect(t.lastLSN).toBeNull();
            continue;
          }
          const walked: number[] = [];
          for (let lsn: number | null = t.lastLSN; lsn !== null; lsn = byLsn.get(lsn)!.prevLSN) walked.push(lsn);
          expect(walked.reverse()).toEqual(mine.map((r) => r.lsn));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('what the database holds is what the newest record for each cell says, rollbacks included', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const s = runWal(steps, { frames: n, ...p }).final;
        const expected: Record<string, Cell> = {};
        for (const cells of Object.values(DEFAULT_PAGES)) Object.assign(expected, cells);
        for (const r of allRecords(s)) {
          if (r.type === 'update' || r.type === 'clr') expected[r.key] = r.after;
        }
        const actual: Record<string, Cell> = {};
        for (const p of s.disk) Object.assign(actual, p.cells);
        for (const f of s.pool) if (f) Object.assign(actual, f.cells);
        expect(actual).toEqual(expected);
      }),
      { numRuns: 400 },
    );
  });

  it('with the rule off, a page can reach disk ahead of its log', () => {
    // Not a property: a witness. The rule is not vacuous — turning it off really does break the invariant.
    const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { enforce: false });
    expect(run.final.disk.find((p) => p.page === 1)!.pageLSN).toBeGreaterThan(run.final.flushedLSN);
  });
});

describe('steal and force (plan.md §25.4 E2)', () => {
  const crashAt = (run: ReturnType<typeof runWal>, i = run.steps.length - 1) => run.steps[i]!.crash;

  describe('steal', () => {
    const script1 = script('begin T1', 'set T1 a = 1', 'read page 2', 'read page 3');

    it('lets the pool write out a page with an uncommitted change, and a crash then finds it on disk', () => {
      const run = runWal(script1, { frames: 2, steal: true });
      expect(crashAt(run).undo).toEqual([{ page: 1, key: 'a', onDisk: 1, committed: 10, by: 'T1', logged: true }]);
      expect(crashAt(run).redo).toEqual([]);
    });

    it('which is only recoverable because the log was flushed first', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { enforce: false });
      expect(crashAt(run).undo).toEqual([{ page: 1, key: 'a', onDisk: 1, committed: 10, by: 'T1', logged: false }]);
      expect(crashAt(run).lostRecords).toBe(1);
    });

    it('a rolled-back change that reached disk still has to be undone there, until the page is written again', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1', 'abort T1'));
      expect(crashAt(run).undo).toMatchObject([{ key: 'a', onDisk: 1, committed: 10, by: 'T1' }]);
      const healed = runWal(script('begin T1', 'set T1 a = 1', 'write page 1', 'abort T1', 'write page 1'));
      expect(crashAt(healed).undo).toEqual([]);
    });
  });

  describe('no-steal', () => {
    it('will not write out a page that holds an uncommitted change, on request', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { steal: false });
      const step = run.steps[2]!;
      expect(step.error).toContain("No-steal: page 1 holds T1's uncommitted change");
      expect(step.state).toEqual(run.steps[1]!.state);
    });

    it('keeps such a page in the pool, and refuses what would need its frame', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'read page 3'), { frames: 2, steal: false });
      const step = run.steps[3]!;
      expect(step.error).toContain('No-steal: every frame holds an uncommitted change (T1)');
      expect(step.state).toEqual(run.steps[2]!.state);
      expect(crashAt(run).undo).toEqual([]);
    });

    it('still makes room by dropping a page that holds nothing uncommitted', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'read page 2', 'read page 3'), { frames: 2, steal: false });
      expect(run.steps.every((r) => r.error === undefined)).toBe(true);
      // Page 2 was clean, so it went; page 1, with T1's change, did not.
      expect(run.final.pool.map((f) => f?.page).sort()).toEqual([1, 3]);
      expect(crashAt(run).undo).toEqual([]);
    });

    it('lets the page out once its transaction has ended', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'commit T1', 'write page 1'), { steal: false });
      expect(run.steps[3]!.error).toBeUndefined();
      // The commit already made the log durable far enough, so there is nothing to flush first.
      expect(run.steps[3]!.effects.map((e) => e.kind)).toEqual(['page-write']);
    });

    it('a rollback never needed the disk: the page was never allowed out', () => {
      const run = runWal(script('begin T1', 'set T1 a = 1', 'abort T1', 'write page 1'), { steal: false });
      expect(crashAt(run, 2).undo).toEqual([]);
      expect(crashAt(run, 2).redo).toEqual([]);
    });
  });

  describe('force', () => {
    const script2 = script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'commit T1');

    it('writes every page the transaction changed as part of the commit, after the log', () => {
      const run = runWal(script2, { force: true });
      const commit = run.steps[3]!;
      expect(commit.effects.filter((e) => e.kind !== 'log-append').map((e) => e.kind)).toEqual([
        'log-flush',
        'page-write',
        'page-write',
      ]);
      expect(commit.effects.filter((e) => e.kind === 'page-write').map((e) => (e as { reason: string }).reason)).toEqual([
        'force',
        'force',
      ]);
      expect(crashAt(run).redo).toEqual([]);
      expect(run.final.pool.every((f) => f === null || f.recLSN === null)).toBe(true);
    });

    it('no-force leaves the same pages owing: a crash after the commit would have to redo them', () => {
      const run = runWal(script2, { force: false });
      expect(crashAt(run).redo.map((c) => `${c.key}:${String(c.onDisk)}→${String(c.committed)} by ${c.by}`)).toEqual([
        'a:10→1 by T1',
        'c:30→2 by T1',
      ]);
      expect(crashAt(run).undo).toEqual([]);
    });

    it('before the commit, nothing is owed in either case', () => {
      for (const force of [true, false]) {
        const run = runWal(script2, { force });
        expect(crashAt(run, 2).redo).toEqual([]);
      }
    });

    it('under no-steal waits to write a page that another running transaction has also changed', () => {
      const run = runWal(
        script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 b = 2', 'commit T1', 'commit T2'),
        { force: true, steal: false },
      );
      const afterT1 = run.steps[4]!;
      expect(afterT1.effects.some((e) => e.kind === 'page-write')).toBe(false);
      expect(afterT1.notes.join(' ')).toContain("T2's uncommitted change");
      // T1 committed, but its change is still only in the pool: a crash now has it to redo.
      expect(afterT1.crash.redo.map((c) => c.key)).toEqual(['a']);
      // T2's commit is what lets the page go.
      const afterT2 = run.steps[5]!;
      expect(afterT2.effects.filter((e) => e.kind === 'page-write')).toHaveLength(1);
      expect(afterT2.crash.redo).toEqual([]);
    });

    it('and writes it when the other transaction rolls back instead, which is not itself a force', () => {
      const run = runWal(
        script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 b = 2', 'commit T1', 'abort T2'),
        { force: true, steal: false },
      );
      const afterAbort = run.steps[5]!;
      expect(afterAbort.effects.filter((e) => e.kind === 'page-write')).toEqual([
        { kind: 'page-write', page: 1, pageLSN: afterAbort.state.pool.find((f) => f?.page === 1)!.pageLSN, reason: 'force' },
      ]);
      expect(afterAbort.crash.redo).toEqual([]);
      expect(afterAbort.crash.undo).toEqual([]);
      expect(run.final.disk.find((p) => p.page === 1)!.cells).toEqual({ a: 1, b: 20 });
    });

    it('under steal writes the shared page at once, T2’s uncommitted change with it', () => {
      const run = runWal(
        script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 b = 2', 'commit T1'),
        { force: true, steal: true },
      );
      const afterT1 = run.steps[4]!;
      expect(afterT1.effects.filter((e) => e.kind === 'page-write')).toHaveLength(1);
      expect(afterT1.crash.redo).toEqual([]);
      expect(afterT1.crash.undo.map((c) => `${c.key} by ${c.by}`)).toEqual(['b by T2']);
    });
  });

  describe('comparing the four', () => {
    const steps = script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 e = 3', 'commit T1');
    const by = (frames: number) => {
      const out = comparePolicies(steps, { frames });
      const pick = (steal: boolean, force: boolean) => out.find((o) => o.steal === steal && o.force === force)!;
      return { pick };
    };

    it('only force pays for pages inside the commit, and only no-force owes them afterwards', () => {
      const { pick } = by(4);
      expect(pick(true, false)).toMatchObject({ commitWrites: 0, endRedo: 3, endUndo: 0, logForces: 1 });
      expect(pick(true, true)).toMatchObject({ commitWrites: 3, endRedo: 0, endUndo: 0, logForces: 1 });
      expect(pick(false, false)).toMatchObject({ commitWrites: 0, endRedo: 3, worstUndo: 0 });
      expect(pick(false, true)).toMatchObject({ commitWrites: 3, endRedo: 0, worstUndo: 0 });
    });

    it('only steal ever owes an undo, and only when the pool is small', () => {
      const small = by(2);
      expect(small.pick(true, false).worstUndo).toBeGreaterThan(0);
      expect(small.pick(true, true).worstUndo).toBeGreaterThan(0);
      expect(small.pick(false, false).worstUndo).toBe(0);
      expect(small.pick(false, false).refused).toBeGreaterThan(0);
      const large = by(4);
      expect(large.pick(true, false).worstUndo).toBe(0);
    });
  });

  describe('whatever the script', () => {
    const key = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const txn = fc.constantFrom('T1', 'T2', 'T3');
    const step: fc.Arbitrary<WalStep> = fc.oneof(
      txn.map((t): WalStep => ({ op: 'begin', txn: t })),
      fc
        .record({ txn, key, value: fc.integer({ min: 0, max: 99 }) })
        .map(({ txn: t, key: k, value }): WalStep => ({ op: 'set', txn: t, key: k, value })),
      txn.map((t): WalStep => ({ op: 'commit', txn: t })),
      txn.map((t): WalStep => ({ op: 'abort', txn: t })),
      fc.constant<WalStep>({ op: 'flush-log' }),
      fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'write-page', page })),
      fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'read-page', page })),
    );
    const scripts = fc.array(step, { maxLength: 30 });
    const frames = fc.integer({ min: 1, max: 4 });

    it('under no-steal no uncommitted value is ever on disk', () => {
      fc.assert(
        fc.property(scripts, frames, fc.boolean(), fc.boolean(), (steps, n, force, enforce) => {
          const run = runWal(steps, { frames: n, steal: false, force, enforce });
          for (const r of run.steps) expect(r.crash.undo).toEqual([]);
        }),
        { numRuns: 500 },
      );
    });

    it('under force and steal no committed value is ever missing from disk', () => {
      fc.assert(
        fc.property(scripts, frames, fc.boolean(), (steps, n, enforce) => {
          const run = runWal(steps, { frames: n, steal: true, force: true, enforce });
          for (const r of run.steps) expect(r.crash.redo).toEqual([]);
        }),
        { numRuns: 500 },
      );
    });

    it('a step a policy refuses changes nothing', () => {
      fc.assert(
        fc.property(scripts, frames, fc.boolean(), fc.boolean(), (steps, n, steal, force) => {
          const run = runWal(steps, { frames: n, steal, force });
          let before = run.initial;
          for (const r of run.steps) {
            if (r.error !== undefined) {
              expect(r.state).toEqual(before);
              expect(r.effects).toEqual([]);
            }
            before = r.state;
          }
        }),
        { numRuns: 300 },
      );
    });

    it('the policies change when pages are written, never what is logged', () => {
      fc.assert(
        fc.property(scripts, frames, (steps, n) => {
          const outcomes = comparePolicies(steps, { frames: n });
          // A step no-steal refuses is not run, so only scripts nobody refused are comparable.
          fc.pre(outcomes.every((o) => o.refused === 0));
          const logs = outcomes.map((o) => JSON.stringify([...o.run.final.log, ...o.run.final.logBuffer]));
          expect(new Set(logs).size).toBe(1);
        }),
        { numRuns: 300 },
      );
    });
  });
});
