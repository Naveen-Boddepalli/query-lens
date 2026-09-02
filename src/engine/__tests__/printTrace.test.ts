import { test } from 'vitest';
import { runQuery, createSeedDatabase } from '../index.ts';
import type { StepEvent } from '../index.ts';

/** `action`, `rule` and `op` each live on only some arms of the union. */
function label(event: StepEvent): string {
  if ('action' in event) return event.action;
  if ('rule' in event) return event.rule;
  if ('op' in event) return event.op;
  return '';
}

test('print trace', () => {
  const db = createSeedDatabase();
  const res = runQuery('SELECT * FROM users WHERE id = 5;', db);
  res.events.forEach((e, i) => {
    console.log(i, e.stage, label(e), e.predictable ? 'PREDICTABLE' : '');
  });
});
