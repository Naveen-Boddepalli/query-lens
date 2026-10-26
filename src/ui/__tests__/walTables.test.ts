import { describe, expect, it } from 'vitest';
import { parseWalStep, runWal } from '../../engine/recovery/wal.ts';
import type { WalStep } from '../../engine/recovery/wal.ts';
import { effectRows, recoveryRows, recoveryStages } from '../walTables.ts';

const script = (...lines: string[]): WalStep[] =>
  lines.map((l) => {
    const step = parseWalStep(l);
    if (!step) throw new Error(`not a step: ${l}`);
    return step;
  });

describe('a step’s effects as rows', () => {
  it('is one row for each effect, numbered in order', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'commit T1'));
    const effects = run.steps[2]!.effects;
    const rows = effectRows(effects);
    expect(rows).toHaveLength(effects.length);
    expect(rows.map((r) => r.n)).toEqual(effects.map((_, i) => i + 1));
    expect(rows.map((r) => r.what)).toEqual(['log record appended', 'log forced', 'log record appended']);
    expect(rows[1]).toMatchObject({ lsn: '1–2', detail: 'for the commit' });
  });

  it('says where a page was found or read, and what was evicted', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'read page 2', 'read page 3'), { frames: 2 });
    const rows = effectRows(run.steps[3]!.effects);
    expect(rows.map((r) => r.what)).toEqual(['page evicted', 'log forced', 'page written to disk', 'page read from disk']);
    expect(rows[0]).toMatchObject({ page: '1', detail: 'from frame 0, dirty' });
    expect(rows[2]).toMatchObject({ page: '1', lsn: '1', detail: 'to make room' });
  });

  it('shows a page written ahead of its log for what it is', () => {
    const run = runWal(script('begin T1', 'set T1 a = 1', 'write page 1'), { enforce: false });
    expect(effectRows(run.steps[2]!.effects)[0]).toMatchObject({
      what: 'written ahead of its log',
      lsn: '1',
      detail: 'the log is durable only through 0',
    });
  });
});

describe('a recovery as rows', () => {
  const run = runWal(
    script(
      'begin T1',
      'begin T2',
      'set T1 a = 1',
      'set T2 c = 2',
      'set T2 d = 3',
      'commit T1',
      'write page 2',
      'crash',
      'recover',
    ),
  );
  const report = run.steps.at(-1)!.recovery!;
  const rows = recoveryRows(report);

  it('has a row for each thing each pass found or did, numbered in order', () => {
    expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => i + 1));
    const count = (pass: string) => rows.filter((r) => r.pass === pass).length;
    expect(count('Analysis')).toBe(1 + report.analysis.dirtyPages.length + report.analysis.txns.length);
    expect(count('Redo')).toBe(report.redo.length + report.ended.length);
    expect(count('Undo')).toBe(report.undo.length);
  });

  it('names the winner and the loser, and says what redo skipped and why', () => {
    expect(rows.find((r) => r.pass === 'Analysis' && r.subject === 'T1')).toMatchObject({ action: 'winner' });
    expect(rows.find((r) => r.pass === 'Analysis' && r.subject === 'T2')).toMatchObject({ action: 'loser' });
    const skipped = rows.filter((r) => r.pass === 'Redo' && r.action === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.why).toContain('already has it');
  });

  it('puts each undo beside the compensation record that logged it', () => {
    const undone = rows.filter((r) => r.pass === 'Undo' && r.action === 'undone');
    expect(undone).toHaveLength(2);
    expect(undone.every((r) => /logged as LSN \d+/.test(r.why))).toBe(true);
  });
});

describe('recovery as three stages', () => {
  const report = runWal(
    script('begin T1', 'begin T2', 'set T1 a = 1', 'set T2 c = 2', 'commit T1', 'write page 2', 'crash', 'recover'),
  ).steps.at(-1)!.recovery!;
  const rows = recoveryRows(report);
  const state = (at: number) => recoveryStages(rows, at).map((s) => `${s.pass}:${s.state}`);
  const count = (pass: string) => rows.filter((r) => r.pass === pass).length;

  it('has the three passes, in the order the machine took them, each with the rows it has', () => {
    const stages = recoveryStages(rows, 0);
    expect(stages.map((s) => s.pass)).toEqual(['Analysis', 'Redo', 'Undo']);
    expect(stages.map((s) => s.steps)).toEqual([count('Analysis'), count('Redo'), count('Undo')]);
    expect(rows.map((r) => r.pass)).toEqual([...rows.map((r) => r.pass)].sort((a, b) => ['Analysis', 'Redo', 'Undo'].indexOf(a) - ['Analysis', 'Redo', 'Undo'].indexOf(b)));
  });

  it('is all pending before the first step and all done after the last', () => {
    expect(state(0)).toEqual(['Analysis:pending', 'Redo:pending', 'Undo:pending']);
    expect(state(rows.length)).toEqual(['Analysis:done', 'Redo:done', 'Undo:done']);
  });

  it('moves from one stage to the next on the row that begins it, and not before', () => {
    const analysis = count('Analysis');
    const redo = count('Redo');
    expect(state(1)[0]).toBe('Analysis:current');
    expect(state(analysis - 1)).toEqual(['Analysis:current', 'Redo:pending', 'Undo:pending']);
    // With the last analysis row taken the pass is finished, and nothing of redo has been.
    expect(state(analysis)).toEqual(['Analysis:done', 'Redo:pending', 'Undo:pending']);
    expect(state(analysis + 1)).toEqual(['Analysis:done', 'Redo:current', 'Undo:pending']);
    expect(state(analysis + redo)).toEqual(['Analysis:done', 'Redo:done', 'Undo:pending']);
    expect(state(analysis + redo + 1)).toEqual(['Analysis:done', 'Redo:done', 'Undo:current']);
  });

  it('calls a pass with nothing to do empty, from the first step to the last', () => {
    const clean = runWal(script('begin T1', 'set T1 a = 1', 'commit T1', 'crash', 'recover')).steps.at(-1)!.recovery!;
    const rows2 = recoveryRows(clean);
    expect(rows2.some((r) => r.pass === 'Undo')).toBe(false);
    for (const at of [0, 1, rows2.length]) {
      expect(recoveryStages(rows2, at).find((s) => s.pass === 'Undo')).toMatchObject({ state: 'empty', steps: 0 });
    }
  });
});

