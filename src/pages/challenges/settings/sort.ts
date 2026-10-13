/** The sort challenge, run on the external merge sort's own driver. */

import { planExternalSort, shuffledRange } from '../../../ui/externalSort.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num, SEED } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'one-merge-pass': (v) => {
    const n = num(v, 'n');
    const p = planExternalSort(shuffledRange(n, SEED), { pageSize: num(v, 'page'), memPages: num(v, 'mem') });
    return {
      passed: n >= 48 && p.mergePassCount === 1,
      facts: [
        { label: 'records', value: String(n) },
        { label: 'pages of data', value: String(p.pageCount) },
        { label: 'runs after pass 0', value: String(p.initialRunCount) },
        { label: 'runs merged at once', value: String(p.fanIn) },
        { label: 'merge passes', value: String(p.mergePassCount) },
        { label: 'page I/Os', value: String(p.totalIO) },
      ],
      toolHref: storageHref({ tool: 'sort', n, page: num(v, 'page'), mem: num(v, 'mem'), seed: SEED }),
    };
  },
};
