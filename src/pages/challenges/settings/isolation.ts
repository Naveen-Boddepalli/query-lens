/** The isolation challenge: the Hermitage suite on both engines, as the matrix computes it. */

import { HERMITAGE_TESTS, runHermitage } from '../../../engine/hermitage.ts';
import { str } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'same-level-different-promise': (v) => {
    const id = str(v, 'anomaly');
    const test = HERMITAGE_TESTS.find((t) => t.id === id)!;
    const locks = runHermitage(test, 'repeatable-read', 'locks').occurred;
    const snapshots = runHermitage(test, 'repeatable-read', 'mvcc').occurred;
    const word = (happens: boolean) => (happens ? 'happens' : 'prevented');
    return {
      passed: locks !== snapshots,
      facts: [
        { label: 'anomaly', value: `${test.id} ${test.name}` },
        { label: 'with locks', value: word(locks) },
        { label: 'with snapshots', value: word(snapshots) },
      ],
      toolHref: `/tools/isolation?c=locks.${test.id}.repeatable-read`,
    };
  },
};
