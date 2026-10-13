/** The row-versus-column challenge, laid out by the columnar tool's own planner. */

import { demoColumns, planLayout } from '../../../ui/columnar.ts';
import type { Layout } from '../../../ui/columnar.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num, pct, SEED, str } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'column-store-saving': (v) => {
    const [n, page] = [num(v, 'n'), num(v, 'page')];
    const layout = str(v, 'layout') as Layout;
    const plan = planLayout(layout, demoColumns(n, SEED), page);
    const one = Math.max(...Object.values(plan.pagesForSingleColumnScan));
    const full = plan.pagesForFullScan;
    return {
      passed: full >= 8 && one <= full * 0.3 && plan.regionsToReconstructOneRow === 1,
      facts: [
        { label: 'pages in a full scan', value: String(full) },
        { label: 'pages in a one-column scan', value: String(one) },
        { label: 'share of the full scan', value: pct(one / full) },
        { label: 'regions to rebuild a row', value: String(plan.regionsToReconstructOneRow) },
      ],
      toolHref: storageHref({ tool: 'columnar', n, page, layout, seed: SEED }),
    };
  },
};
