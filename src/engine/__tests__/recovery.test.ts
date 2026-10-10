import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGES, isTxnRecord, parseWalStep, runWal } from '../recovery/wal.ts';
import type { Cell, WalState, WalStep } from '../recovery/wal.ts';

const script = (...lines: string[]): WalStep[] =>
  lines.map((l) => {
    const step = parseWalStep(l);
    if (!step) throw new Error(`not a step: ${l}`);
    return step;
  });

/** What the database holds: the disk, with the pool's pages over it. */
function logical(s: WalState): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const p of s.disk) Object.assign(out, p.cells);
  for (const f of s.pool) if (f) Object.assign(out, f.cells);
  return out;
}

/** What recovery must produce: the initial data with every committed transaction's changes, in log order. */
function committed(s: WalState): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const cells of Object.values(DEFAULT_PAGES)) Object.assign(out, cells);
  const winners = new Set(s.log.filter(isTxnRecord).filter((r) => r.type === 'commit').map((r) => r.txn));
  for (const r of s.log) if (r.type === 'update' && winners.has(r.txn)) out[r.key] = r.after;
  return out;
}

const finalOf = (steps: WalStep[], options?: Parameters<typeof runWal>[1]) => runWal(steps, options);

describe('checkpoints', () => {
  it('copies the two tables into the log, writes no page, forces the log, and moves the master record', () => {
    const run = finalOf(script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'write page 1', 'set T1 e = 3', 'checkpoint'));
    const step = run.steps[5]!;
    expect(step.effects.filter((e) => e.kind === 'page-write')).toEqual([]);
    const records = step.state.log.filter((r) => r.type === 'begin-checkpoint' || r.type === 'end-checkpoint');
    expect(records.map((r) => r.type)).toEqual(['begin-checkpoint', 'end-checkpoint']);
    const end = records[1]!;
    if (end.type !== 'end-checkpoint') throw new Error('unreachable');
    // Page 1 was written (clean, so not in the table); pages 2 and 3 are dirty from LSN 2 and 3.
    expect(end.dirtyPages).toEqual([
      { page: 2, recLSN: 2 },
      { page: 3, recLSN: 3 },
    ]);
    expect(end.txns).toEqual([{ txn: 'T1', lastLSN: 3 }]);
    expect(step.state.masterLSN).toBe(end.beginLSN);
    expect(step.state.flushedLSN).toBe(end.lsn);
  });

  it('is fuzzy: work between its begin and its end is not in its tables', () => {
    const run = finalOf(
      script('begin T1', 'set T1 a = 1', 'begin checkpoint', 'set T1 c = 2', 'end checkpoint'),
    );
    const end = run.final.log.find((r) => r.type === 'end-checkpoint');
    if (end?.type !== 'end-checkpoint') throw new Error('no end record');
    // The update of c (LSN 3) came after the begin record (LSN 2) and is not in what the checkpoint copied.
    expect(end.dirtyPages).toEqual([{ page: 1, recLSN: 1 }]);
    expect(end.txns).toEqual([{ txn: 'T1', lastLSN: 1 }]);
    expect(run.steps[3]!.state.masterLSN).toBeNull();
    expect(run.final.masterLSN).toBe(2);
  });

  it('refuses a second begin, and an end with nothing begun', () => {
    expect(finalOf(script('begin checkpoint', 'begin checkpoint')).steps[1]!.error).toContain('already in progress');
    expect(finalOf(script('end checkpoint')).steps[0]!.error).toContain('No checkpoint is in progress');
  });
});

describe('a crash', () => {
  const run = finalOf(
    script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 c = 2', 'write page 1', 'commit T2', 'set T1 e = 3', 'crash'),
  );
  const before = run.steps[6]!.state;
  const after = run.steps[7]!.state;

  it('loses the pool, the log buffer and every transaction, and keeps the disk, the durable log and the master', () => {
    expect(after.crashed).toBe(true);
    expect(after.pool.every((f) => f === null)).toBe(true);
    expect(after.logBuffer).toEqual([]);
    expect(after.txns).toEqual([]);
    expect(after.disk).toEqual(before.disk);
    expect(after.log).toEqual(before.log);
    expect(after.masterLSN).toBe(before.masterLSN);
  });

  it('says what it lost', () => {
    expect(run.steps[7]!.notes[0]).toMatch(/Gone: .* in the pool .*dirty/);
  });

  it('runs nothing else until recovery', () => {
    const more = finalOf([...script('begin T1', 'set T1 a = 1', 'crash'), ...script('set T1 a = 2', 'commit T1', 'begin T2', 'read page 1', 'write page 1', 'flush log', 'checkpoint')]);
    for (const r of more.steps.slice(3)) expect(r.error).toContain('The machine is down');
  });

  it('numbers the next record from the end of the durable log, so a lost record’s LSN is reused', () => {
    const r = finalOf(script('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'flush log', 'set T1 e = 3', 'crash'));
    expect(r.final.nextLSN).toBe(3);
  });
});

describe('recovery', () => {
  const winnerAndLoser = script(
    'begin T1',
    'begin T2',
    'set T1 a = 1',
    'set T2 c = 2',
    'set T2 d = 3',
    'commit T1',
    'write page 2',
    'crash',
    'recover',
  );

  it('redoes what committed and never reached disk, and undoes what reached disk and never committed', () => {
    const run = finalOf(winnerAndLoser);
    const r = run.steps[8]!;
    expect(r.error).toBeUndefined();
    expect(r.recovery!.analysis.losers).toEqual(['T2']);
    expect(r.recovery!.redo.filter((x) => x.action === 'redo').map((x) => `${x.lsn}:${x.key}`)).toEqual(['1:a']);
    expect(r.recovery!.undo.filter((x) => x.action === 'undo').map((x) => x.detail)).toEqual([
      'd goes back from 3 to 40 on page 2',
      'c goes back from 2 to 30 on page 2',
    ]);
    expect(logical(run.final)).toEqual(committed(run.final));
    expect(logical(run.final)).toMatchObject({ a: 1, c: 30, d: 40 });
  });

  it('logs each undo as a compensation record, then an end record, and forces them', () => {
    const run = finalOf(winnerAndLoser);
    const written = run.steps[8]!.effects.flatMap((e) => (e.kind === 'log-append' ? [e.record] : []));
    expect(written.map((r) => r.type)).toEqual(['end', 'clr', 'clr', 'end']);
    const clrs = written.filter((r) => r.type === 'clr');
    // T2's updates were LSN 2 (c) and 3 (d); undone newest first, each CLR pointing at what is left to undo.
    expect(clrs.map((r) => (r.type === 'clr' ? r.undoNextLSN : -1))).toEqual([2, null]);
    expect(run.final.logBuffer).toEqual([]);
  });

  it('writes the end record a committed transaction never got', () => {
    const run = finalOf(script('begin T1', 'set T1 a = 1', 'commit T1', 'crash', 'recover'));
    // The commit forced the log; the end record that followed it was still in the buffer.
    expect(run.steps[4]!.recovery!.ended).toEqual(['T1']);
  });

  it('skips a record the page already has, and says so', () => {
    const run = finalOf(script('begin T1', 'set T1 a = 1', 'write page 1', 'set T1 c = 2', 'commit T1', 'crash', 'recover'));
    const redo = run.steps[6]!.recovery!.redo;
    expect(redo.map((x) => x.action)).toEqual(['skip', 'redo']);
    expect(redo[0]!.reason).toContain('pageLSN 1 ≥ 1');
  });

  it('skips, by the dirty page table, a change from before the page last became dirty', () => {
    // Page 2 holds the oldest recLSN, so redo starts at LSN 1 and meets LSN 2, a change to page 1 that was written to
    // disk before page 1 was dirtied again at LSN 3. The checkpoint's table says so, and redo need not even look.
    const run = finalOf(
      script(
        'begin T1',
        'set T1 c = 1',
        'set T1 a = 2',
        'write page 1',
        'set T1 a = 5',
        'checkpoint',
        'crash',
        'recover',
      ),
    );
    const redo = run.steps[7]!.recovery!.redo;
    const second = redo.find((x) => x.lsn === 2)!;
    expect(second.action).toBe('skip');
    expect(second.reason).toContain('was clean until LSN 3');
  });

  it('does not undo a transaction that rolled back and ended before the crash', () => {
    const run = finalOf(script('begin T1', 'set T1 a = 1', 'abort T1', 'flush log', 'crash', 'recover'));
    const report = run.steps[5]!.recovery!;
    expect(report.analysis.losers).toEqual([]);
    expect(report.undo).toEqual([]);
    expect(report.ended).toEqual([]);
    expect(logical(run.final)).toEqual(committed(run.final));
  });

  it('does not end again a committed transaction whose end record is durable', () => {
    const run = finalOf(script('begin T1', 'set T1 a = 1', 'commit T1', 'flush log', 'crash', 'recover'));
    expect(run.steps[5]!.recovery!.ended).toEqual([]);
    expect(run.steps[5]!.recovery!.analysis.txns).toEqual([]);
  });

  it('starts from the checkpoint, and so never looks at what it already covers', () => {
    const run = finalOf(
      script(
        'begin T1',
        'set T1 a = 1',
        'set T1 c = 2',
        'commit T1',
        'write page 1',
        'write page 2',
        'checkpoint',
        'begin T2',
        'set T2 e = 9',
        'flush log',
        'crash',
        'recover',
      ),
    );
    const report = run.steps[11]!.recovery!;
    expect(report.analysis.checkpoint).not.toBeNull();
    expect(report.analysis.from).toBe(report.analysis.checkpoint);
    // Pages 1 and 2 were clean at the checkpoint, so nothing before it is redone.
    expect(report.redo.every((x) => x.lsn > report.analysis.from)).toBe(true);
    expect(report.analysis.losers).toEqual(['T2']);
    expect(logical(run.final)).toEqual(committed(run.final));
  });

  it('uses the checkpoint’s own tables for work that began before it', () => {
    const run = finalOf(
      script('begin T1', 'set T1 a = 1', 'checkpoint', 'set T1 c = 2', 'crash', 'recover'),
    );
    const report = run.steps[5]!.recovery!;
    // T1's first update is before the checkpoint, so only the checkpoint's table knows about it.
    expect(report.analysis.from).toBeGreaterThan(1);
    expect(report.analysis.losers).toEqual(['T1']);
    expect(report.analysis.redoFrom).toBe(1);
    expect(logical(run.final)).toEqual(committed(run.final));
    expect(logical(run.final)).toMatchObject({ a: 10, c: 30 });
  });

  it('a recovery that is itself interrupted picks up where it left off, and undoes nothing twice', () => {
    const steps = script(
      'begin T1',
      'set T1 a = 1',
      'set T1 c = 2',
      'set T1 e = 3',
      'write page 1',
      'write page 2',
      'write page 3',
      'crash',
      'recover, crash after 2',
      'recover',
    );
    const run = finalOf(steps);
    const interrupted = run.steps[8]!;
    expect(interrupted.recovery!.interrupted).toBe(true);
    expect(interrupted.state.crashed).toBe(true);
    const again = run.steps[9]!;
    // Two undos were written and forced before the stop: e, then c. The second recovery finds the last of those
    // CLRs, follows it to what is left (a), undoes that, and ends the transaction. Nothing is undone twice.
    expect(again.recovery!.undo.map((x) => x.action)).toEqual(['follow', 'undo', 'end']);
    expect(logical(run.final)).toEqual(committed(run.final));
    const clrs = run.final.log.filter((r) => r.type === 'clr');
    expect(clrs).toHaveLength(3);
  });

  it('refuses to recover a machine that has not crashed', () => {
    expect(finalOf(script('recover')).steps[0]!.error).toContain('has not crashed');
  });

  it('with the rule off, a page ahead of its log is a change recovery cannot undo', () => {
    const steps = script('begin T1', 'set T1 a = 1', 'write page 1', 'crash', 'recover');
    const broken = finalOf(steps, { enforce: false });
    expect(logical(broken.final).a).toBe(1);
    expect(committed(broken.final).a).toBe(10);
    // The same script with the rule enforced is recovered.
    const kept = finalOf(steps, { enforce: true });
    expect(logical(kept.final).a).toBe(10);
  });
});

describe('whatever the script and wherever the crash', () => {
  const key = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const txn = fc.constantFrom('T1', 'T2', 'T3');
  const step: fc.Arbitrary<WalStep> = fc.oneof(
    { weight: 2, arbitrary: txn.map((t): WalStep => ({ op: 'begin', txn: t })) },
    {
      weight: 5,
      arbitrary: fc
        .record({ txn, key, value: fc.integer({ min: 0, max: 99 }) })
        .map(({ txn: t, key: k, value }): WalStep => ({ op: 'set', txn: t, key: k, value })),
    },
    { weight: 2, arbitrary: txn.map((t): WalStep => ({ op: 'commit', txn: t })) },
    { weight: 1, arbitrary: txn.map((t): WalStep => ({ op: 'abort', txn: t })) },
    { weight: 1, arbitrary: fc.constant<WalStep>({ op: 'flush-log' }) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'write-page', page })) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 4 }).map((page): WalStep => ({ op: 'read-page', page })) },
    { weight: 1, arbitrary: fc.constant<WalStep>({ op: 'checkpoint' }) },
    { weight: 1, arbitrary: fc.constant<WalStep>({ op: 'checkpoint-begin' }) },
    { weight: 1, arbitrary: fc.constant<WalStep>({ op: 'checkpoint-end' }) },
  );
  const scripts = fc.array(step, { maxLength: 30 });
  const frames = fc.integer({ min: 1, max: 4 });
  const policy = fc.record({ steal: fc.boolean(), force: fc.boolean() });
  const crash = (): WalStep => ({ op: 'crash' });
  const recover = (crashAfter?: number): WalStep => ({ op: 'recover', ...(crashAfter === undefined ? {} : { crashAfter }) });

  it('recovery leaves exactly the committed state', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const run = runWal([...steps, crash(), recover()], { frames: n, ...p });
        const last = run.steps.at(-1)!;
        expect(last.error).toBeUndefined();
        expect(last.state.crashed).toBe(false);
        expect(logical(last.state)).toEqual(committed(last.state));
      }),
      { numRuns: 600 },
    );
  });

  it('and so does a recovery that was interrupted, however many times and wherever', () => {
    fc.assert(
      fc.property(
        scripts,
        frames,
        policy,
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 3 }),
        (steps, n, p, cuts) => {
          const interrupted = cuts.flatMap((k) => [recover(k)]);
          const run = runWal([...steps, crash(), ...interrupted, recover()], { frames: n, ...p });
          const last = run.steps.at(-1)!;
          // A recovery that has nothing left to do after an earlier one finished is refused, harmlessly.
          if (last.error !== undefined) {
            expect(last.error).toContain('has not crashed');
          }
          expect(last.state.crashed).toBe(false);
          expect(logical(last.state)).toEqual(committed(last.state));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never writes more compensation records than there are changes to undo', () => {
    fc.assert(
      fc.property(scripts, frames, fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 3 }), (steps, n, cuts) => {
        const run = runWal([...steps, crash(), ...cuts.map((k) => recover(k)), recover()], { frames: n });
        const records = run.final.log.filter(isTxnRecord);
        for (const t of new Set(records.map((r) => r.txn))) {
          const mine = records.filter((r) => r.txn === t);
          const updates = mine.filter((r) => r.type === 'update').length;
          const clrs = mine.filter((r) => r.type === 'clr').length;
          expect(clrs).toBeLessThanOrEqual(updates);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('analysis names as losers exactly the transactions that wrote and neither committed nor ended', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const run = runWal([...steps, crash(), recover()], { frames: n, ...p });
        const atCrash = run.steps[steps.length]!.state;
        const records = atCrash.log.filter(isTxnRecord);
        const wrote = new Set(records.filter((r) => r.type === 'update').map((r) => r.txn));
        const settled = new Set(records.filter((r) => r.type === 'commit' || r.type === 'end').map((r) => r.txn));
        const expected = [...wrote].filter((t) => !settled.has(t)).sort();
        const got = [...run.steps.at(-1)!.recovery!.analysis.losers].sort();
        expect(got).toEqual(expected);
      }),
      { numRuns: 400 },
    );
  });

  it('recovery is the same with or without checkpoints in the log', () => {
    fc.assert(
      fc.property(scripts, frames, (steps, n) => {
        const withCheckpoints = runWal([...steps, crash(), recover()], { frames: n });
        const without = runWal(
          [...steps.filter((s) => !s.op.startsWith('checkpoint')), crash(), recover()],
          { frames: n },
        );
        // A checkpoint's refusals aside, the same transactions did the same things.
        const a = logical(withCheckpoints.final);
        const b = logical(without.final);
        expect(a).toEqual(b);
      }),
      { numRuns: 300 },
    );
  });

  it('the crash image predicted exactly what recovery then had to fix', () => {
    fc.assert(
      fc.property(scripts, frames, policy, (steps, n, p) => {
        const run = runWal([...steps, crash(), recover()], { frames: n, ...p });
        const atCrash = run.steps[steps.length]!;
        const wrong = new Set([...atCrash.crash.undo, ...atCrash.crash.redo].map((c) => c.key));
        const diskAtCrash = Object.assign({}, ...atCrash.state.disk.map((d) => d.cells)) as Record<string, Cell>;
        const want = committed(run.final);
        const actuallyWrong = Object.keys(diskAtCrash).filter((k) => diskAtCrash[k] !== want[k]);
        expect([...wrong].sort()).toEqual(actuallyWrong.sort());
      }),
      { numRuns: 400 },
    );
  });
});
