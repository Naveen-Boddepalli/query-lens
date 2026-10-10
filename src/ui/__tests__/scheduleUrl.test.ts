import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_STEPS } from '../../engine/schedule.ts';
import { decodeSchedule, encodeSchedule, MAX_STATEMENT_LENGTH } from '../scheduleUrl.ts';

describe('a schedule in a URL (plan.md §25.4 D1)', () => {
  const steps = [
    { session: 'A', sql: 'BEGIN' },
    { session: 'B', sql: "SELECT * FROM accounts WHERE owner = 'a;b:c' -- ok" },
  ];

  it('round-trips, whatever punctuation the SQL holds', () => {
    expect(decodeSchedule(encodeSchedule(steps))).toEqual(steps);
  });

  it('survives being a real query parameter', () => {
    const params = new URLSearchParams();
    params.set('s', encodeSchedule(steps));
    expect(decodeSchedule(new URLSearchParams(params.toString()).get('s'))).toEqual(steps);
  });

  it('decodes anything malformed to nothing, rather than throwing', () => {
    const bad: (string | null)[] = [
      null,
      '',
      'not json',
      '{"A":"BEGIN"}',
      '[["C","BEGIN"]]',
      '[["A"]]',
      '[["A",""]]',
      '[["A",5]]',
      JSON.stringify([['A', 'x'.repeat(MAX_STATEMENT_LENGTH + 1)]]),
      JSON.stringify(Array.from({ length: MAX_SCHEDULE_STEPS + 1 }, () => ['A', 'BEGIN'])),
    ];
    for (const raw of bad) expect(decodeSchedule(raw)).toBeNull();
  });
});
