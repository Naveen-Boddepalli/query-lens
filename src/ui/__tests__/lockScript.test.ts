import { describe, expect, it } from 'vitest';
import { heldBy, waitingBy } from '../lockSimulation.ts';
import {
  decodeLockSteps,
  encodeLockSteps,
  formatLockStep,
  MAX_LOCK_STEPS,
  parseLockStep,
  runLockSteps,
} from '../lockScript.ts';
import type { LockStep } from '../lockScript.ts';

const steps = (...lines: string[]): LockStep[] => lines.map((l) => parseLockStep(l)!);

describe('a lock step as text', () => {
  it('reads a request, with the short forms and any case', () => {
    expect(parseLockStep('T1 shared 0')).toEqual({ op: 'request', transaction: 'T1', mode: 'shared', page: 0 });
    expect(parseLockStep('t2 X 3')).toEqual({ op: 'request', transaction: 'T2', mode: 'exclusive', page: 3 });
    expect(parseLockStep('  T1   s   1  ')).toEqual({ op: 'request', transaction: 'T1', mode: 'shared', page: 1 });
  });

  it('reads a release', () => {
    expect(parseLockStep('T1 release shared 0')).toEqual({ op: 'release', transaction: 'T1', mode: 'shared', page: 0 });
    expect(parseLockStep('T2 unlock x 2')).toEqual({ op: 'release', transaction: 'T2', mode: 'exclusive', page: 2 });
  });

  it('rejects what is not a step: a third transaction, a missing page, a page that is not there', () => {
    for (const bad of ['', 'T3 shared 0', 'T1 shared', 'T1 shared 4', 'T1 shared -1', 'T1 grab 0', 'shared 0', 'T1 shared 0 now']) {
      expect(parseLockStep(bad), bad).toBeNull();
    }
  });

  it('formats what it parses', () => {
    for (const line of ['T1 shared 0', 'T2 exclusive 3', 'T1 release exclusive 2']) {
      expect(formatLockStep(parseLockStep(line)!)).toBe(line);
    }
  });
});

describe('running a script', () => {
  it('grants shared locks together and makes an exclusive request wait', () => {
    const run = runLockSteps(steps('T1 shared 0', 'T2 shared 0', 'T1 exclusive 0'));
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'granted', 'blocked']);
    expect(waitingBy(run.state, 'T1')).toEqual([{ resource: 0, mode: 'exclusive' }]);
    expect(heldBy(run.state, 'T2')).toEqual([{ resource: 0, mode: 'shared' }]);
  });

  it('finds the deadlock in the example, and the transaction that arrived last is the victim', () => {
    const run = runLockSteps(steps('T1 exclusive 0', 'T2 exclusive 1', 'T1 exclusive 1', 'T2 exclusive 0'));
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'granted', 'blocked', 'deadlock']);
    expect(run.entries[3]!.victim).toBe('T2');
    expect(heldBy(run.state, 'T1').map((h) => h.resource).sort()).toEqual([0, 1]);
    expect(run.state.aborted).toEqual(['T2']);
  });

  it('a deadlock needs only one page: two shared holders who both want to write', () => {
    const run = runLockSteps(steps('T1 shared 0', 'T2 shared 0', 'T1 exclusive 0', 'T2 exclusive 0'));
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'granted', 'blocked', 'deadlock']);
  });

  it('a release promotes the waiter, and releasing what is not held says so', () => {
    const run = runLockSteps(steps('T1 exclusive 0', 'T2 exclusive 0', 'T1 release exclusive 0', 'T1 release exclusive 0'));
    expect(run.entries.map((e) => e.kind)).toEqual(['granted', 'blocked', 'released', 'not-held']);
    expect(heldBy(run.state, 'T2')).toEqual([{ resource: 0, mode: 'exclusive' }]);
    expect(waitingBy(run.state, 'T2')).toEqual([]);
  });

  it('narrates every step in words', () => {
    const run = runLockSteps(steps('T1 exclusive 0', 'T2 shared 0'));
    expect(run.entries[1]!.lines[0]).toMatch(/T2 requests a shared lock on page 0, held by T1/);
  });

  it('runs no more than the most steps a script may have', () => {
    const many = Array.from({ length: MAX_LOCK_STEPS + 5 }, () => parseLockStep('T1 shared 0')!);
    expect(runLockSteps(many).entries).toHaveLength(MAX_LOCK_STEPS);
  });
});

describe('a script in a link', () => {
  it('round-trips', () => {
    const s = steps('T1 shared 0', 'T2 exclusive 0', 'T1 release shared 0');
    expect(decodeLockSteps(encodeLockSteps(s))).toEqual(s);
  });

  it('decodes anything else to nothing, without throwing', () => {
    for (const bad of [null, '', 'not json', '{}', '[1]', '["T1 grab 0"]', JSON.stringify(Array(MAX_LOCK_STEPS + 1).fill('T1 shared 0')), 'x'.repeat(5000)]) {
      expect(decodeLockSteps(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });
});
