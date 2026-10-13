/** The hash join challenge, run on the Grace hash join's own driver. */

import { demoKeys, planHashJoin } from '../../../ui/hashJoin.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num, SEED } from './shared.ts';
import type { Checkers } from './shared.ts';

export const CHECKERS: Checkers = {
  'more-memory-more-io': (v) => {
    const [build, probe, page, mem] = [num(v, 'build'), num(v, 'probe'), num(v, 'page'), num(v, 'mem')];
    const { buildKeys, probeKeys } = demoKeys(build, probe, SEED);
    const at = (memPages: number) => planHashJoin(buildKeys, probeKeys, { pageSize: page, memPages });
    const [less, more] = [at(mem), at(mem + 1)];
    const row = (memPages: number, p: ReturnType<typeof at>): string[] => [
      String(memPages),
      p.fitsInMemory ? 'none — it fits' : String(p.numPartitions),
      String(p.partitionIO),
      String(p.buildProbeIO),
      String(p.totalIO),
    ];
    return {
      passed: more.totalIO > less.totalIO,
      facts: [
        { label: `page I/Os with ${String(mem)} buffer pages`, value: String(less.totalIO) },
        { label: `with ${String(mem + 1)}`, value: String(more.totalIO) },
        { label: 'difference', value: `${more.totalIO >= less.totalIO ? '+' : ''}${String(more.totalIO - less.totalIO)}` },
      ],
      tables: [
        {
          caption: 'The same join, one buffer page apart',
          columns: ['Buffer pages', 'Partitions', 'Partitioning I/O', 'Build and probe I/O', 'Total I/O'],
          rows: [row(mem, less), row(mem + 1, more)],
        },
      ],
      toolHref: storageHref({ tool: 'hash-join', build, probe, page, mem, seed: SEED }),
    };
  },
};
