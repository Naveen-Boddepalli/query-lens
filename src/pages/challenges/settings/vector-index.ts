/** The vector index challenge, averaged over the tool's twenty queries. */

import {
  buildHnsw,
  buildIvf,
  demoPoints,
  exactTopK,
  hnswSearch,
  ivfSearch,
  queryPoints,
  recallAt,
  VECTOR_LIMITS,
} from '../../../ui/vectorIndex.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { fixed, num, pct, SEED, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** The average, over the tool's twenty queries, of a vector search's cost and recall — the tool's own averaging. */
function vectorAverage(n: number, k: number, method: 'ivf' | 'hnsw', parameter: number) {
  const points = demoPoints(n, SEED);
  const queries = queryPoints(VECTOR_LIMITS.queries, SEED);
  const truths = queries.map((q) => exactTopK(points, q, k));
  const centroids = Math.max(2, Math.round(Math.sqrt(n)));
  const ivf = method === 'ivf' ? buildIvf(points, centroids, SEED) : null;
  const hnsw = method === 'hnsw' ? buildHnsw(points, SEED) : null;
  let computations = 0;
  let recall = 0;
  queries.forEach((q, i) => {
    const r = ivf ? ivfSearch(points, ivf, q, k, parameter) : hnswSearch(points, hnsw!, q, k, parameter);
    computations += r.computations;
    recall += recallAt(r.ids, truths[i]!);
  });
  return { computations: computations / queries.length, recall: recall / queries.length, centroids };
}

export const CHECKERS: Checkers = {
  'recall-for-a-quarter': (v) => {
    const [n, k, parameter] = [num(v, 'n'), num(v, 'k'), num(v, 'parameter')];
    const method = str(v, 'method') === 'hnsw' ? 'hnsw' : 'ivf';
    const toolHref = storageHref({ tool: 'vector-index', n, k, seed: SEED });
    const centroids = Math.max(2, Math.round(Math.sqrt(n)));
    const most = method === 'ivf' ? centroids : n;
    if (parameter > most) {
      return {
        passed: false,
        facts: [],
        problem:
          method === 'ivf'
            ? `With ${String(n)} points there are ${String(centroids)} clusters: probe from 1 to ${String(centroids)}.`
            : `A beam is at most as wide as the table: from 1 to ${String(n)}.`,
        toolHref,
      };
    }
    const a = vectorAverage(n, k, method, parameter);
    return {
      passed: a.recall >= 0.95 - 1e-9 && a.computations <= 0.25 * n,
      facts: [
        { label: 'distance computations', value: fixed(a.computations, 1) },
        { label: 'of brute force’s', value: pct(a.computations / n) },
        { label: `recall of the true ${String(k)}`, value: pct(a.recall) },
      ],
      toolHref,
    };
  },
};
