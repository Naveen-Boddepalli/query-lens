import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildHnsw,
  buildIvf,
  demoPoints,
  exactTopK,
  hnswSearch,
  ivfSearch,
  planVectorIndex,
  queryPoints,
  recallAt,
  VECTOR_LIMITS,
} from '../vectorIndex.ts';

describe('exactTopK — the ground truth every method is scored against', () => {
  it('returns k distinct points, nearest first', () => {
    const pts = demoPoints(100, 1);
    const q = [0.5, 0.5] as const;
    const top = exactTopK(pts, q, 5);
    expect(new Set(top).size).toBe(5);
    const d = (id: number) => (pts[id]![0] - q[0]) ** 2 + (pts[id]![1] - q[1]) ** 2;
    for (let i = 1; i < top.length; i++) expect(d(top[i]!)).toBeGreaterThanOrEqual(d(top[i - 1]!));
  });
});

describe('IVF', () => {
  it('probing every cluster is exhaustive, so recall is exactly 1', () => {
    const pts = demoPoints(200, 2);
    const ivf = buildIvf(pts, 12, 2);
    for (const q of queryPoints(10, 2)) {
      const r = ivfSearch(pts, ivf, q, 8, ivf.centroids.length);
      expect(recallAt(r.ids, exactTopK(pts, q, 8))).toBe(1);
    }
  });

  it('cost never falls as more clusters are probed', () => {
    const pts = demoPoints(200, 3);
    const ivf = buildIvf(pts, 14, 3);
    const q = [0.3, 0.7] as const;
    let last = -1;
    for (const nprobe of [1, 2, 4, 8, 14]) {
      const c = ivfSearch(pts, ivf, q, 10, nprobe).computations;
      expect(c).toBeGreaterThanOrEqual(last);
      last = c;
    }
  });

  it('every point lives in exactly one cluster', () => {
    const pts = demoPoints(150, 4);
    const ivf = buildIvf(pts, 10, 4);
    const all = ivf.lists.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: pts.length }, (_, i) => i));
  });
});

describe('HNSW', () => {
  // Regression: an early version kept only the M nearest neighbours, which wired each cluster to itself and left
  // layer 0 disconnected — only 56 of 200 points were reachable from the entry. The neighbour-selection heuristic
  // is what keeps the bridges. This test fails if that heuristic is reverted.
  it('layer 0 is fully connected from its entry point', () => {
    for (const n of [120, 200, 400]) {
      const pts = demoPoints(n, 1);
      const g = buildHnsw(pts, 1);
      const seen = new Set<number>([g.entry]);
      const queue = [g.entry];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const nb of g.links[cur]![0] ?? []) {
          if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
        }
      }
      expect(seen.size).toBe(n);
    }
  });

  it('a beam as wide as the whole graph is exhaustive, so recall is exactly 1', () => {
    const pts = demoPoints(200, 5);
    const g = buildHnsw(pts, 5);
    for (const q of queryPoints(10, 5)) {
      const r = hnswSearch(pts, g, q, 8, pts.length);
      expect(recallAt(r.ids, exactTopK(pts, q, 8))).toBe(1);
    }
  });

  it('returns distinct points only, never more than k', () => {
    const pts = demoPoints(200, 6);
    const g = buildHnsw(pts, 6);
    const r = hnswSearch(pts, g, [0.1, 0.9] as const, 7, 32);
    expect(r.ids).toHaveLength(7);
    expect(new Set(r.ids).size).toBe(7);
  });
});

describe('planVectorIndex', () => {
  it('brute force is the exact baseline, and every method is scored against the same truth', () => {
    const plan = planVectorIndex(200, 10, 1);
    const brute = plan.curve.find((c) => c.method === 'brute')!;
    expect(brute.avgRecall).toBe(1);
    expect(brute.avgComputations).toBe(200);
  });

  it('HNSW recall never falls as its beam widens', () => {
    const plan = planVectorIndex(400, 10, 1);
    const hnsw = plan.curve.filter((c) => c.method === 'hnsw');
    for (let i = 1; i < hnsw.length; i++) {
      expect(hnsw[i]!.avgRecall).toBeGreaterThanOrEqual(hnsw[i - 1]!.avgRecall);
    }
    expect(hnsw[hnsw.length - 1]!.avgRecall).toBe(1);
  });

  it('is deterministic: the same inputs produce the same plan', () => {
    expect(JSON.stringify(planVectorIndex(150, 8, 3))).toEqual(JSON.stringify(planVectorIndex(150, 8, 3)));
  });

  it('clamps out-of-range inputs rather than producing a broken index', () => {
    const plan = planVectorIndex(9999, 999, 1);
    expect(plan.points).toHaveLength(VECTOR_LIMITS.maxPoints);
    expect(plan.k).toBe(VECTOR_LIMITS.maxK);
  });

  it('never crashes, and every method returns exactly k distinct in-range ids, for any legal input', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: VECTOR_LIMITS.minPoints, max: 200 }),
        fc.integer({ min: VECTOR_LIMITS.minK, max: VECTOR_LIMITS.maxK }),
        fc.integer({ min: 0, max: 9999 }),
        (count, k, seed) => {
          const pts = demoPoints(count, seed);
          const ivf = buildIvf(pts, Math.max(2, Math.round(Math.sqrt(count))), seed);
          const g = buildHnsw(pts, seed);
          const q = queryPoints(1, seed)[0]!;
          const full = ivfSearch(pts, ivf, q, k, ivf.centroids.length);
          expect(full.ids).toHaveLength(k);
          expect(new Set(full.ids).size).toBe(k);
          expect(recallAt(full.ids, exactTopK(pts, q, k))).toBe(1);
          const h = hnswSearch(pts, g, q, k, count);
          expect(h.ids).toHaveLength(k);
          expect(new Set(h.ids).size).toBe(k);
          expect(recallAt(h.ids, exactTopK(pts, q, k))).toBe(1);
        },
      ),
    );
  });
});
