import { useMemo, useState } from 'react';
import { planVectorIndex, queryPoints, exactTopK, VECTOR_LIMITS, buildIvf, buildHnsw, ivfSearch, hnswSearch, recallAt } from '../../ui/vectorIndex.ts';
import { btnGhost } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  Inspector,
  MetricStrip,
  Segmented,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The vector-index standalone (plan.md §25.4 F6 `/tools/vector-index`). Brute force, IVF and HNSW answer the same
 * nearest-neighbour question; the table scores each by distance computations and recall. The scatter is 2-D so the
 * geometry can be seen. Its driver is `src/ui/vectorIndex.ts`.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): points and k in the inspector, one query's recall by each method
 * in the readout, the scatter on the stage (with the query picker in its header), and the averaged cost-and-recall
 * table and the HNSW layers below.
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

  const ivfFound = [...ivfSet].filter((id) => truthSet.has(id)).length;
  const hnswFound = [...hnswSet].filter((id) => truthSet.has(id)).length;
  const topLayer = plan.hnswLevelCounts.length - 1;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="indexing"
        header={
          <ToolHeader
            id="vector-index"
            title="Vector index"
            summary="Brute force, IVF and HNSW find a query's nearest points. Compare the distances each computes and the neighbours it finds."
            about={
              <>
                <p>
                  Three ways to find the points closest to a query: check every point (brute force), search only the
                  nearest clusters (IVF), or walk a layered graph of neighbours (HNSW). Each is scored by how many
                  distances it computes and how many of the true nearest it finds. The points are 2-D so the geometry
                  is visible.
                </p>
                <p>
                  Two dimensions, a few hundred points, and every number on this page is measured from the same seeded
                  points and queries. The shape of the trade-off carries to high-dimensional vectors; the exact numbers
                  do not.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(n)} points · k ${String(k)}`}>
            <ControlGroup legend="Data">
              <ControlRow label="Points" htmlFor="vec-n">
                <Stepper id="vec-n" value={n} min={VECTOR_LIMITS.minPoints} max={VECTOR_LIMITS.maxPoints} step={20} unit="points" onChange={setN} />
              </ControlRow>
              <ControlRow label="k (neighbours)" labelId="vec-k" stacked>
                <Segmented
                  labelledBy="vec-k"
                  tone="stage"
                  value={String(k)}
                  onChange={(v) => { setK(Number(v)); }}
                  options={[3, 5, 10, 15, 20].map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
              <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={`${btnGhost} self-start`}>
                Shuffle the points
              </button>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Brute force', value: '100.0%', sub: `recall · ${plural(plan.points.length, 'distance')}` },
              { label: 'IVF, probing 2 clusters', value: `${(recallAt(ivfHit.ids, truth) * 100).toFixed(1)}%`, sub: `recall · ${plural(ivfHit.computations, 'distance')}` },
              { label: 'HNSW, beam width 16', value: `${(recallAt(hnswHit.ids, truth) * 100).toFixed(1)}%`, sub: `recall · ${plural(hnswHit.computations, 'distance')}` },
              { label: 'HNSW layers', value: plan.hnswLevelCounts.length, sub: `${plural(plan.hnswLevelCounts[topLayer] ?? 0, 'point')} on the top one` },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Nearest neighbours"
            legend={`Green: the true ${String(plan.k)} nearest · ring: the query`}
            toolbar={
              <div className="flex items-center gap-2">
                <label htmlFor="vec-q" className="text-label text-ink-dim">
                  Query
                </label>
                <Stepper id="vec-q" value={queryIndex + 1} min={1} max={queries.length} buttonLabels={['Previous query', 'Next query']} onChange={(v) => { setQueryIndex(v - 1); }} />
              </div>
            }
          >
            <svg
              viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
              className="mx-auto w-full max-w-sm rounded-lg border border-edge/70 bg-surface-3/60"
              role="img"
              aria-label={`Scatter of ${String(plan.points.length)} points with query ${String(queryIndex + 1)} and its ${String(plan.k)} true nearest neighbours`}
            >
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
          </StagePanel>
        }
        narration={`For query ${String(queryIndex + 1)}, IVF probing 2 clusters finds ${String(ivfFound)} of the true ${String(plan.k)} and HNSW at beam width 16 finds ${String(hnswFound)}; brute force reads all ${String(plan.points.length)} points to find every one.`}
      >
        <ToolSection
          title={`Cost and recall, averaged over ${String(VECTOR_LIMITS.queries)} queries`}
          description="Brute force always finds everything but reads every point. Which approximate method is cheaper for a given recall depends on the size: at 200 points HNSW reaches full recall for fewer distances than IVF, and at 400 points IVF does. Both are measured here, and neither result settles the question at real scale."
        >
          <ScrollRegion label="Cost and recall by method" className="overflow-x-auto" stickyFirst>
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
                    <td className="min-w-32 py-1.5 pr-3 text-ink">{c.label}</td>
                    <td className="py-1.5 text-right font-mono text-ink tabular-nums">{c.avgComputations.toFixed(1)}</td>
                    <td className="py-1.5 pl-4">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-4 sm:w-40">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${String(Math.round(c.avgRecall * 100))}%` }} />
                        </div>
                        <span className="font-mono text-ink tabular-nums">{(c.avgRecall * 100).toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </ToolSection>
        <ToolSection
          title="HNSW layers: how many points reach each one"
          description="Every point is on layer 0. Each higher layer keeps roughly one in M of the points below it, so the search drops quickly through the sparse top layers before the dense bottom one."
        >
          <div className="flex flex-col gap-2">
            {plan.hnswLevelCounts.map((count, layer) => (
              <div key={layer} className="flex items-center gap-3 text-label">
                <span className="w-20 shrink-0 text-ink-dim">layer {layer}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-4">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${String(Math.round((count / maxLayerCount) * 100))}%` }} />
                </div>
                <span className="w-12 text-right font-mono text-ink tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        </ToolSection>
      </ToolShell>
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
