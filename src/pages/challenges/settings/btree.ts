/** The B+Tree challenge, built by the sandbox's own insert. */

import { createTree, height, insert, validate } from '../../../engine/index.ts';
import { num } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'third-level': (v) => {
    const [fanout, keys] = [num(v, 'fanout'), num(v, 'keys')];
    const tree = createTree(fanout, 0);
    for (let k = 1; k <= keys; k += 1) insert(tree, k, { pageId: Math.abs(k) >> 2, slot: Math.abs(k) & 3 });
    const levels = height(tree);
    const problems = validate(tree);
    return {
      passed: levels >= 3 && keys <= 12 && problems.length === 0,
      facts: [
        { label: 'keys', value: String(keys) },
        { label: 'levels', value: String(levels) },
        { label: 'pages', value: String(Object.keys(tree.nodes).length) },
        { label: 'invariants', value: problems.length === 0 ? 'hold' : `${String(problems.length)} broken` },
      ],
      toolHref: `/tools/btree?keys=${Array.from({ length: keys }, (_, i) => i + 1).join(',')}&fanout=${String(fanout)}`,
    };
  },
};
