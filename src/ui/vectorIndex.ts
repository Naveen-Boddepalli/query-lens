/**
 * plan.md §25.4 F6 `/tools/vector-index`: three ways to answer "which stored points are closest to this query point?",
 * scored by the two numbers that actually decide between them — how many distance computations a query costs, and
 * recall (what fraction of the true k nearest it found).
 *
 *   - **Brute force**: compute the distance to every stored point. Exact, always. Cost is the whole table.
 *   - **IVF** (inverted file): cluster the points around C centroids and remember which points sit in which cluster.
 *     A query finds the `nprobe` nearest centroids and searches only those clusters. Cheap, but a true neighbour
 *     that landed in an unvisited cluster is lost.
 *   - **HNSW** (hierarchical navigable small world): a multi-layer proximity graph. Each point appears on layer 0,
 *     and on each higher layer with probability falling geometrically, so the top layers are sparse and act as a
 *     highway. A query walks greedily down from the top, then runs a bounded beam search (`ef`) on layer 0.
 *
 * Pure and total, like `/tools/lsm` and `/tools/hash-index`: the points, the clusters and the graph are all built
 * up front from a seed, and every distance computation is counted, not estimated. The points are 2-D on purpose,
 * so the layout is visible. The recall-vs-cost curve is the same shape in 768 dimensions, and this module does not
 * claim otherwise.
 */

export type Point = readonly [number, number];

export interface VectorLimits {
  minPoints: number;
  maxPoints: number;
  minK: number;
  maxK: number;
  queries: number;
}

export const VECTOR_LIMITS: VectorLimits = {
  minPoints: 60,
  maxPoints: 400,
  minK: 3,
  maxK: 20,
  queries: 20,
};

/** A seeded PRNG (mulberry32), the generator the other standalone tools use, so a `?seed=` link reproduces. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points in the unit square, drawn from a handful of blobs so they actually cluster, the way real embeddings do. */
export function demoPoints(count: number, seed: number): Point[] {
  const rnd = makeRng(seed);
  const blobs = Array.from({ length: 6 }, () => [rnd(), rnd()] as const);
  return Array.from({ length: count }, () => {
    const [cx, cy] = blobs[Math.floor(rnd() * blobs.length)]!;
    const spread = 0.12;
    const x = Math.min(1, Math.max(0, cx + (rnd() - 0.5) * spread));
    const y = Math.min(1, Math.max(0, cy + (rnd() - 0.5) * spread));
    return [x, y] as const;
  });
}

export function queryPoints(count: number, seed: number): Point[] {
  const rnd = makeRng(seed * 7919 + 13);
  return Array.from({ length: count }, () => [rnd(), rnd()] as const);
}

/** Squared Euclidean distance: ordering is the same as true distance, and it skips a square root per call. */
function dist2(a: Point, b: Point): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** A counter every distance computation goes through, so cost is measured where it happens. */
interface Meter {
  computations: number;
  d: (a: Point, b: Point) => number;
}

function meter(): Meter {
  const m: Meter = {
    computations: 0,
    d: (a, b) => {
      m.computations += 1;
      return dist2(a, b);
    },
  };
  return m;
}

/** Exact k nearest by brute force, the ground truth every other method is scored against. */
export function exactTopK(points: readonly Point[], query: Point, k: number): number[] {
  return points
    .map((p, id) => ({ id, d: dist2(p, query) }))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .slice(0, k)
    .map((r) => r.id);
}

export interface IvfIndex {
  centroids: Point[];
  lists: number[][];
}

/** A few Lloyd iterations from seeded starting centroids — deterministic, and close enough for a teaching index. */
export function buildIvf(points: readonly Point[], centroidCount: number, seed: number): IvfIndex {
  const rnd = makeRng(seed * 31 + 7);
  const C = Math.max(1, Math.min(centroidCount, points.length));
  const picked = new Set<number>();
  while (picked.size < C) picked.add(Math.floor(rnd() * points.length));
  let centroids: Point[] = [...picked].map((i) => points[i]!);

  let lists: number[][] = [];
  for (let iter = 0; iter < 5; iter++) {
    lists = centroids.map(() => []);
    points.forEach((p, id) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, ci) => {
        const d = dist2(p, c);
        if (d < bestD) { bestD = d; best = ci; }
      });
      lists[best]!.push(id);
    });
    centroids = centroids.map((c, ci) => {
      const members = lists[ci]!;
      if (members.length === 0) return c;
      const x = members.reduce((s, id) => s + points[id]![0], 0) / members.length;
      const y = members.reduce((s, id) => s + points[id]![1], 0) / members.length;
      return [x, y] as const;
    });
  }
  return { centroids, lists };
}

export function ivfSearch(
  points: readonly Point[],
  index: IvfIndex,
  query: Point,
  k: number,
  nprobe: number,
): { ids: number[]; computations: number } {
  const m = meter();
  const probes = index.centroids
    .map((c, ci) => ({ ci, d: m.d(c, query) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.min(nprobe, index.centroids.length));
  const candidates: { id: number; d: number }[] = [];
  for (const { ci } of probes) {
    for (const id of index.lists[ci]!) candidates.push({ id, d: m.d(points[id]!, query) });
  }
  const ids = candidates.sort((a, b) => a.d - b.d || a.id - b.id).slice(0, k).map((r) => r.id);
  return { ids, computations: m.computations };
}

export interface HnswGraph {
  /** `links[id][layer]` — the neighbours of point `id` on that layer, closest first. */
  links: number[][][];
  /** The highest layer each point reaches. */
  levelOf: number[];
  entry: number;
  maxLevel: number;
  M: number;
  Mmax0: number;
}

const HNSW_M = 6;

/** Insert points one at a time: a random layer per point, greedy descent above it, and a beam search to link it in. */
export function buildHnsw(points: readonly Point[], seed: number): HnswGraph {
  const rnd = makeRng(seed * 101 + 3);
  const mL = 1 / Math.log(HNSW_M);
  const M = HNSW_M;
  const Mmax0 = 2 * HNSW_M;
  const links: number[][][] = [];
  const levelOf: number[] = [];
  let entry = -1;
  let maxLevel = -1;

  const dist = (a: number, b: number) => dist2(points[a]!, points[b]!);

  /**
   * The HNSW neighbour-selection heuristic: keep a candidate only if it sits closer to the base point than to any
   * neighbour already kept. Taking just the M nearest instead wires each cluster to itself and never bridges to the
   * others, which left layer 0 disconnected in this module's first version.
   */
  const select = (base: number, cands: readonly number[], cap: number): number[] => {
    const kept: number[] = [];
    for (const e of cands) {
      if (kept.length >= cap) break;
      const dEB = dist(e, base);
      if (kept.every((r) => dist(e, r) >= dEB)) kept.push(e);
    }
    for (const e of cands) {
      if (kept.length >= cap) break;
      if (!kept.includes(e)) kept.push(e);
    }
    return kept;
  };

  const searchLayer = (q: Point, starts: number[], ef: number, layer: number): number[] => {
    const visited = new Set<number>(starts);
    const frontier = starts.map((id) => ({ id, d: dist2(points[id]!, q) }));
    let result = [...frontier].sort((a, b) => a.d - b.d).slice(0, ef);
    while (frontier.length > 0) {
      frontier.sort((a, b) => a.d - b.d);
      const cur = frontier.shift()!;
      const worst = result[result.length - 1]!.d;
      if (cur.d > worst && result.length >= ef) break;
      for (const nb of links[cur.id]![layer] ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const d = dist2(points[nb]!, q);
        if (result.length < ef || d < result[result.length - 1]!.d) {
          frontier.push({ id: nb, d });
          result = [...result, { id: nb, d }].sort((a, b) => a.d - b.d).slice(0, ef);
        }
      }
    }
    return result.map((r) => r.id);
  };

  points.forEach((_, id) => {
    const level = Math.floor(-Math.log(Math.max(rnd(), 1e-12)) * mL);
    links[id] = Array.from({ length: level + 1 }, () => []);
    levelOf[id] = level;

    if (entry === -1) {
      entry = id;
      maxLevel = level;
      return;
    }

    let cur = entry;
    for (let l = maxLevel; l > level; l--) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const nb of links[cur]![l] ?? []) {
          if (dist(nb, id) < dist(cur, id)) { cur = nb; improved = true; }
        }
      }
    }

    for (let l = Math.min(level, maxLevel); l >= 0; l--) {
      const cands = searchLayer(points[id]!, [cur], 32, l);
      const cap = l === 0 ? Mmax0 : M;
      const mine = select(id, cands, M);
      links[id][l] = mine;
      for (const nb of mine) {
        const list = links[nb]![l] ?? (links[nb]![l] = []);
        list.push(id);
        if (list.length > cap) {
          const byDist = [...list].sort((a, b) => dist(a, nb) - dist(b, nb));
          links[nb]![l] = select(nb, byDist, cap);
        }
      }
      cur = cands[0] ?? cur;
    }

    if (level > maxLevel) {
      entry = id;
      maxLevel = level;
    }
  });

  // Pruning a neighbour's list can drop its link back to a point, and a point left with out-links only is unreachable
  // from the entry: a full-width search then misses true neighbours. Layer 0 is made undirected, and any component the
  // entry cannot reach is joined to it by its nearest pair, so every starting point reaches every point.
  const n = points.length;
  const linkZero = (a: number, b: number) => {
    const la = links[a]![0]!;
    if (!la.includes(b)) la.push(b);
    const lb = links[b]![0]!;
    if (!lb.includes(a)) lb.push(a);
  };
  const reachableFromEntry = (): Set<number> => {
    const seen = new Set<number>([entry]);
    const stack = [entry];
    while (stack.length > 0) {
      const c = stack.pop()!;
      for (const nb of links[c]![0] ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    return seen;
  };
  for (let a = 0; a < n; a++) {
    for (const b of [...links[a]![0]!]) linkZero(a, b);
  }
  for (let reach = reachableFromEntry(); reach.size < n; reach = reachableFromEntry()) {
    let bestU = -1;
    let bestR = -1;
    let bestD = Infinity;
    for (let u = 0; u < n; u++) {
      if (reach.has(u)) continue;
      for (const r of reach) {
        const d = dist(u, r);
        if (d < bestD) {
          bestD = d;
          bestU = u;
          bestR = r;
        }
      }
    }
    linkZero(bestU, bestR);
  }

  return { links, levelOf, entry, maxLevel, M, Mmax0 };
}

export function hnswSearch(
  points: readonly Point[],
  graph: HnswGraph,
  query: Point,
  k: number,
  ef: number,
): { ids: number[]; computations: number } {
  const m = meter();
  let cur = graph.entry;
  let curD = m.d(points[cur]!, query);
  for (let l = graph.maxLevel; l > 0; l--) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const nb of graph.links[cur]![l] ?? []) {
        const d = m.d(points[nb]!, query);
        if (d < curD) { cur = nb; curD = d; improved = true; }
      }
    }
  }

  const width = Math.max(ef, k);
  const visited = new Set<number>([cur]);
  const frontier = [{ id: cur, d: curD }];
  let result = [{ id: cur, d: curD }];
  while (frontier.length > 0) {
    frontier.sort((a, b) => a.d - b.d);
    const c = frontier.shift()!;
    if (result.length >= width && c.d > result[result.length - 1]!.d) break;
    for (const nb of graph.links[c.id]![0] ?? []) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      const d = m.d(points[nb]!, query);
      if (result.length < width || d < result[result.length - 1]!.d) {
        frontier.push({ id: nb, d });
        result = [...result, { id: nb, d }].sort((a, b) => a.d - b.d).slice(0, width);
      }
    }
  }
  return { ids: result.slice(0, k).map((r) => r.id), computations: m.computations };
}

export function recallAt(found: readonly number[], truth: readonly number[]): number {
  if (truth.length === 0) return 1;
  const want = new Set(truth);
  return found.filter((id) => want.has(id)).length / truth.length;
}

export interface CurvePoint {
  method: 'brute' | 'ivf' | 'hnsw';
  parameter: number;
  label: string;
  avgComputations: number;
  avgRecall: number;
}

export interface VectorPlan {
  points: Point[];
  k: number;
  centroidCount: number;
  ivfLists: number[];
  hnswLevelCounts: number[];
  curve: CurvePoint[];
}

/** The whole comparison: every method's cost and recall, averaged over a fixed set of seeded queries. */
export function planVectorIndex(rawCount: number, rawK: number, seed: number): VectorPlan {
  const count = Math.max(VECTOR_LIMITS.minPoints, Math.min(VECTOR_LIMITS.maxPoints, Math.round(rawCount)));
  const k = Math.max(VECTOR_LIMITS.minK, Math.min(VECTOR_LIMITS.maxK, Math.round(rawK)));
  const points = demoPoints(count, seed);
  const queries = queryPoints(VECTOR_LIMITS.queries, seed);
  const truths = queries.map((q) => exactTopK(points, q, k));

  const centroidCount = Math.max(2, Math.round(Math.sqrt(count)));
  const ivf = buildIvf(points, centroidCount, seed);
  const hnsw = buildHnsw(points, seed);

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const curve: CurvePoint[] = [];

  curve.push({
    method: 'brute',
    parameter: count,
    label: 'brute force',
    avgComputations: count,
    avgRecall: 1,
  });

  for (const nprobe of [1, 2, 4, 8, centroidCount].filter((v, i, a) => v <= centroidCount && a.indexOf(v) === i)) {
    const runs = queries.map((q, qi) => {
      const r = ivfSearch(points, ivf, q, k, nprobe);
      return { c: r.computations, rec: recallAt(r.ids, truths[qi]!) };
    });
    curve.push({
      method: 'ivf',
      parameter: nprobe,
      label: `IVF, probe ${String(nprobe)} of ${String(centroidCount)} clusters`,
      avgComputations: avg(runs.map((r) => r.c)),
      avgRecall: avg(runs.map((r) => r.rec)),
    });
  }

  for (const ef of [k, 16, 32, 64, 128, 256, count].filter((v, i, a) => v >= k && v <= count && a.indexOf(v) === i)) {
    const runs = queries.map((q, qi) => {
      const r = hnswSearch(points, hnsw, q, k, ef);
      return { c: r.computations, rec: recallAt(r.ids, truths[qi]!) };
    });
    curve.push({
      method: 'hnsw',
      parameter: ef,
      label: `HNSW, beam width ${String(ef)}`,
      avgComputations: avg(runs.map((r) => r.c)),
      avgRecall: avg(runs.map((r) => r.rec)),
    });
  }

  const hnswLevelCounts: number[] = [];
  for (let l = 0; l <= hnsw.maxLevel; l++) hnswLevelCounts.push(hnsw.levelOf.filter((lv) => lv >= l).length);

  return {
    points,
    k,
    centroidCount,
    ivfLists: ivf.lists.map((list) => list.length),
    hnswLevelCounts,
    curve,
  };
}
