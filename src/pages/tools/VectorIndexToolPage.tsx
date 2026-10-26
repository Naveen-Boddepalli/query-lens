import { useMemo, useState } from 'react';
import { planVectorIndex, queryPoints, exactTopK, VECTOR_LIMITS, buildIvf, buildHnsw, ivfSearch, hnswSearch, recallAt } from '../../ui/vectorIndex.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The vector-index standalone (plan.md §25.4 F6 `/tools/vector-index`). Brute force, IVF and HNSW answer the same
 * nearest-neighbour question; the table scores each by distance computations and recall. The scatter is 2-D so the
 * geometry can be seen. Its driver is `src/ui/vectorIndex.ts`.
 *
 * URL state: `n` (points), `k` and `seed`, parsed defensively. A pasted link is a stranger's input.
 */

const DEFAULTS = { n: 200, k: 10, seed: 1 };
const MAX_SEED = 999_999;
const SIZE = 320;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    n: clampInt(p.get('n'), VECTOR_LIMITS.minPoints, VECTOR_LIMITS.maxPoints, DEFAULTS.n),
    k: clampInt(p.get('k'), VECTOR_LIMITS.minK, VECTOR_LIMITS.maxK, DEFAULTS.k),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();

export function VectorIndexToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [k, setK] = useState(INITIAL.k);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [queryIndex, setQueryIndex] = useState(0);

  const plan = useMemo(() => planVectorIndex(n, k, seed), [n, k, seed]);
  const queries = useMemo(() => queryPoints(VECTOR_LIMITS.queries, seed), [seed]);
  const query = queries[queryIndex] ?? queries[0]!;
  const truth = useMemo(() => exactTopK(plan.points, query, plan.k), [plan, query]);

  // The query's own ranking by the two approximate methods, at a setting that shows the trade-off.
  const ivf = useMemo(() => buildIvf(plan.points, plan.centroidCount, seed), [plan, seed]);
  const hnsw = useMemo(() => buildHnsw(plan.points, seed), [plan, seed]);
  const ivfHit = useMemo(() => ivfSearch(plan.points, ivf, query, plan.k, 2), [plan, ivf, query]);
  const hnswHit = useMemo(() => hnswSearch(plan.points, hnsw, query, plan.k, 16), [plan, hnsw, query]);

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('n', String(n));
    p.set('k', String(k));
    p.set('seed', String(seed));
    return p.toString();
  }, [n, k, seed]);
  useAddressBarQuery(shareQuery);

  const truthSet = new Set(truth);
  const ivfSet = new Set(ivfHit.ids);
  const hnswSet = new Set(hnswHit.ids);
  const maxLayerCount = Math.max(...plan.hnswLevelCounts);
  const sx = (x: number) => 12 + x * (SIZE - 24);
  const sy = (y: number) => 12 + (1 - y) * (SIZE - 24);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Vector index">
        Three ways to find the points closest to a query: check every point (brute force), search only the nearest
        clusters (IVF), or walk a layered graph of neighbours (HNSW). Each is scored by how many distances it
        computes and how many of the true nearest it finds. The points are 2-D so the geometry is visible.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Points
          <input
            type="number"
            min={VECTOR_LIMITS.minPoints}
            max={VECTOR_LIMITS.maxPoints}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= VECTOR_LIMITS.minPoints && v <= VECTOR_LIMITS.maxPoints) setN(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          k (neighbours)
          <select value={k} onChange={(e) => { setK(Number(e.target.value)); }} className={inputField}>
            {[3, 5, 10, 15, 20].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select value={queryIndex} onChange={(e) => { setQueryIndex(Number(e.target.value)); }} className={inputField}>
            {queries.map((_, i) => <option key={i} value={i}>query {i + 1}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={btnSecondary}>
          Reshuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">Cost and recall, averaged over {VECTOR_LIMITS.queries} queries</h3>
        <ScrollRegion label="Cost and recall by method" className="overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="text-left text-ink-dim">
                <th className="pb-2 font-medium">Method</th>
                <th className="pb-2 text-right font-medium">Distances computed</th>
                <th className="pb-2 pl-4 font-medium">Recall of the true {plan.k}</th>
              </tr>
            </thead>
            <tbody>
              {plan.curve.map((c) => (
                <tr key={`${c.method}-${String(c.parameter)}`} className="border-t border-edge/60">
                  <td className="py-1.5 text-ink">{c.label}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-ink">{c.avgComputations.toFixed(1)}</td>
                  <td className="py-1.5 pl-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-4">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${String(Math.round(c.avgRecall * 100))}%` }} />
                      </div>
                      <span className="font-mono tabular-nums text-ink">{(c.avgRecall * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
        <p className="text-label text-ink-dim">
          Brute force always finds everything but reads every point. Which approximate method is cheaper for a given
          recall depends on the size: at 200 points HNSW reaches full recall for fewer distances than IVF, and at 400
          points IVF does. Both are measured here, and neither result settles the question at real scale.
        </p>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">The points, and query {queryIndex + 1}&rsquo;s true neighbours</h3>
        <div className="flex flex-col gap-4 lg:flex-row">
          <svg viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`} className="w-full max-w-xs shrink-0 rounded-lg border border-edge bg-surface-3" role="img" aria-label="Scatter of points with the query and its true nearest neighbours">
            {plan.points.map((p, id) => (
              <circle
                key={id}
                cx={sx(p[0])}
                cy={sy(p[1])}
                r={truthSet.has(id) ? 5 : 2.5}
                className={truthSet.has(id) ? 'fill-hit stroke-ink stroke-1' : 'fill-ink-dim/60'}
              />
            ))}
            <circle cx={sx(query[0])} cy={sy(query[1])} r={7} className="fill-none stroke-accent stroke-2" />
          </svg>
          <div className="flex flex-col gap-3 text-label">
            <p className="text-ink-dim">
              <span className="text-hit">Green</span> points are the true {plan.k} nearest; the ring is the query. Both
              approximate methods below are run on this query alone, at settings that show the trade-off.
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
              <dt className="text-ink-dim">IVF, probing 2 clusters — found</dt>
              <dd className="text-right font-mono tabular-nums text-ink">
                {(recallAt(ivfHit.ids, truth) * 100).toFixed(1)}% · {ivfHit.computations} distances
              </dd>
              <dt className="text-ink-dim">HNSW, beam width 16 — found</dt>
              <dd className="text-right font-mono tabular-nums text-ink">
                {(recallAt(hnswHit.ids, truth) * 100).toFixed(1)}% · {hnswHit.computations} distances
              </dd>
              <dt className="text-ink-dim">exact neighbours IVF also returned</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{[...ivfSet].filter((id) => truthSet.has(id)).length}</dd>
              <dt className="text-ink-dim">exact neighbours HNSW also returned</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{[...hnswSet].filter((id) => truthSet.has(id)).length}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
        <h3 className="text-body font-semibold text-ink">HNSW layers: how many points reach each one</h3>
        <div className="flex flex-col gap-2">
          {plan.hnswLevelCounts.map((count, layer) => (
            <div key={layer} className="flex items-center gap-3 text-label">
              <span className="w-20 shrink-0 text-ink-dim">layer {layer}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-4">
                <div className="h-full rounded-full bg-accent" style={{ width: `${String(Math.round((count / maxLayerCount) * 100))}%` }} />
              </div>
              <span className="w-12 text-right font-mono tabular-nums text-ink">{count}</span>
            </div>
          ))}
        </div>
        <p className="text-label text-ink-dim">
          Every point is on layer 0. Each higher layer keeps roughly one in M of the points below it, so the search
          drops quickly through the sparse top layers before the dense bottom one.
        </p>
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Two dimensions, a few hundred points, and every number on this page is measured from the same seeded points
        and queries. The shape of the trade-off carries to high-dimensional vectors; the exact numbers do not.
      </p>
    </div>
  );
}
