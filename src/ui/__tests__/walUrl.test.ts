import { describe, expect, it } from 'vitest';
import { MAX_WAL_STEPS } from '../../engine/recovery/wal.ts';
import type { WalStep } from '../../engine/recovery/wal.ts';
import { decodeWalSteps, encodeWalSteps } from '../walUrl.ts';

const steps: WalStep[] = [
  { op: 'begin', txn: 'T1' },
  { op: 'set', txn: 'T1', key: 'a', value: 99 },
  { op: 'write-page', page: 1 },
  { op: 'flush-log' },
  { op: 'commit', txn: 'T1' },
  { op: 'read-page', page: 3 },
  { op: 'abort', txn: 'T2' },
];

describe('walUrl', () => {
  it('round-trips a script', () => {
    expect(decodeWalSteps(encodeWalSteps(steps))).toEqual(steps);
  });

  it('round-trips the empty script', () => {
    expect(decodeWalSteps(encodeWalSteps([]))).toEqual([]);
  });

  it('decodes anything else to nothing, without throwing', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{}',
      '[1]',
      '["drop table"]',
      '["set T1 a ="]',
      JSON.stringify(Array.from({ length: MAX_WAL_STEPS + 1 }, () => 'flush log')),
      JSON.stringify(['x'.repeat(100)]),
      '[' + '"flush log",'.repeat(2_000) + '"flush log"]',
    ]) {
      expect(decodeWalSteps(raw)).toBeNull();
    }
  });
});
