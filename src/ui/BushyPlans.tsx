import { useMemo, useState } from 'react';
import { connectedPlanCounts, planCounts, searchJoinShapes, treeText } from '../engine/planner/joinShapes.ts';
import type { ShapeSearch } from '../engine/planner/joinShapes.ts';
import type { JoinOrderEdge, JoinOrderNode } from '../engine/planner/joinOrder.ts';
import { EXPLORER_SIZES, EXPLORER_TABLES, fkGraph, GRAPH_SHAPES, SHAPE_LABELS, sweepShapes } from './joinShapeExplorer.ts';
import type { GraphShape } from './joinShapeExplorer.ts';
import { btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from './primitives.ts';

/**
 * plan.md §27.5 T4: bushy plans beside left-deep ones over the same subset lattice — how many more there are, what the
 * cheapest of each costs on the demo query, and, in an explorer over foreign-key graphs, the shapes where a bushy one
 * wins. Everything here is `joinShapes.ts`'s; nothing is priced on the page.
 */

const fmt = (n: number) => n.toLocaleString('en-US');
const GROWTH = [2, 3, 4, 5, 6, 8, 10];
const TWO_PAIRS: { shape: GraphShape; sizes: number[] } = { shape: 'chain', sizes: [5, 600, 5, 20] };

/** "the same plan", or how much cheaper the bushy one is. */
function verdict(search: ShapeSearch): string {
  const left = search.leftDeep.get(search.fullMask)!;
  const any = search.bushy.get(search.fullMask)!;
  if (any.pages >= left.pages) return 'No bushy plan is cheaper here: the cheapest plan of any shape is left-deep.';
  const saved = 1 - any.pages / left.pages;
  const ratio = left.pages / any.pages;
  const percent = saved < 0.01 ? `${(saved * 100).toFixed(1)}%` : `${String(Math.round(saved * 100))}%`;
  return `The bushy plan is ${percent} cheaper${ratio >= 1.05 ? ` — ${ratio.toFixed(2)}× fewer pages` : ''}.`;
}

function Winners({ search, label }: { search: ShapeSearch; label: string }) {
  const left = search.leftDeep.get(search.fullMask)!;
  const any = search.bushy.get(search.fullMask)!;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label={label}>
        <div className="rounded-lg border border-edge bg-surface-3 p-3">
          <p className="text-label font-medium text-ink-dim">cheapest left-deep</p>
          <p className="mt-1 font-mono text-label break-words text-ink">{treeText(left.tree)}</p>
          <p className="mt-1 text-label text-ink-dim">
            <span className="tabular-nums text-ink">{fmt(left.pages)}</span> estimated pages
          </p>
        </div>
        <div className="rounded-lg border border-accent/50 bg-surface-3 p-3">
          <p className="text-label font-medium text-ink-dim">cheapest of any shape</p>
          <p className="mt-1 font-mono text-label break-words text-ink">{treeText(any.tree)}</p>
          <p className="mt-1 text-label text-ink-dim">
            <span className="tabular-nums text-ink">{fmt(any.pages)}</span> estimated pages
          </p>
        </div>
      </div>
      <p className="mt-2 text-label text-ink" role="status">
        {verdict(search)}
      </p>
    </>
  );
}

export function BushyPlans({ nodes, edges, rowsPerPage }: { nodes: readonly JoinOrderNode[]; edges: readonly JoinOrderEdge[]; rowsPerPage: number }) {
  const demo = useMemo(() => searchJoinShapes(nodes, edges, rowsPerPage), [nodes, edges, rowsPerPage]);
  const counts = planCounts(nodes.length);
  const connected = useMemo(() => connectedPlanCounts(nodes, edges), [nodes, edges]);
  const nameSet = (mask: number) => demo.nodeNames.filter((_, i) => mask & (1 << i)).join(', ');

  const [shape, setShape] = useState<GraphShape>(TWO_PAIRS.shape);
  const [sizes, setSizes] = useState<number[]>(TWO_PAIRS.sizes);
  const explored = useMemo(() => {
    const graph = fkGraph(shape, sizes, rowsPerPage);
    return searchJoinShapes(graph.nodes, graph.edges, rowsPerPage);
  }, [shape, sizes, rowsPerPage]);
  const sweep = useMemo(() => sweepShapes(rowsPerPage), [rowsPerPage]);

  return (
    <section className={`${panelSurface} flex flex-col gap-3 p-4`} aria-labelledby="bushy-heading">
      <h2 id="bushy-heading" className="text-body font-semibold text-ink">
        Bushy plans
      </h2>
      <p className="text-label leading-relaxed text-ink-dim">
        Every plan above is <em>left-deep</em>: it adds one table at a time, so the inner side of every join is a stored
        table. A <em>bushy</em> plan may also join two results, and then its inner side is computed once, written out, and
        read once for every outer row. The search is the same walk up the subset lattice, but for each subset it tries
        every way to split it in two, not only which one table goes last. The engine runs left-deep chains only, so these
        are plans priced, never run.
      </p>

      <ul className="flex flex-col gap-1 text-label text-ink-dim">
        <li>
          For these {nodes.length} tables: <span className="tabular-nums text-ink">{fmt(counts.leftDeep)}</span> left-deep
          orders and <span className="tabular-nums text-ink">{fmt(counts.bushy)}</span> bushy trees, outer told apart from
          inner — {fmt(counts.bushy / counts.leftDeep)}× as many. With no cross product anywhere,{' '}
          <span className="tabular-nums text-ink">{fmt(connected.leftDeep)}</span> and{' '}
          <span className="tabular-nums text-ink">{fmt(connected.bushy)}</span>.
        </li>
        <li>
          The search never lists them: over the same {fmt(demo.fullMask)} subsets it prices{' '}
          <span className="tabular-nums text-ink">{fmt(demo.steps.leftDeep)}</span> candidates left-deep and{' '}
          <span className="tabular-nums text-ink">{fmt(demo.steps.bushy)}</span> splits bushy.
        </li>
      </ul>

      <table className="w-full max-w-md text-left text-label">
        <caption className="mb-1 text-left text-ink-dim">How the two spaces grow</caption>
        <thead className="text-ink-dim">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">Tables</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Left-deep</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Bushy</th>
            <th scope="col" className="py-1 text-right font-medium">×</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-ink">
          {GROWTH.map((n) => {
            const c = planCounts(n);
            return (
              <tr key={n} className="border-t border-edge">
                <td className="py-1 pr-3">{n}</td>
                <td className="py-1 pr-3 text-right">{fmt(c.leftDeep)}</td>
                <td className="py-1 pr-3 text-right">{fmt(c.bushy)}</td>
                <td className="py-1 text-right">{fmt(Math.round(c.bushy / c.leftDeep))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="mt-2 text-label font-semibold text-ink">The demo query, both ways</h3>
      <Winners search={demo} label="The demo query's cheapest plans" />
      <details>
        <summary className="cursor-pointer text-label text-ink-dim">
          Every split of all {nodes.length} tables the search priced ({demo.splits.get(demo.fullMask)?.length ?? 0}), cheapest first
        </summary>
        <ol className="mt-1 flex flex-col gap-0.5 text-label text-ink-dim">
          {(demo.splits.get(demo.fullMask) ?? []).map((split) => (
            <li key={`${String(split.outer)}-${String(split.inner)}`}>
              <span className="font-mono text-ink">
                ({nameSet(split.outer)}) ⋈ ({nameSet(split.inner)})
              </span>{' '}
              — <span className="tabular-nums">{fmt(split.pages)}</span> pages
            </li>
          ))}
        </ol>
      </details>
      <p className="text-label leading-relaxed text-ink-dim">
        Here every plan for the same tables has the same row estimate — System R&rsquo;s, where each join predicate keeps
        one row in the larger of its two columns&rsquo; distinct counts — so two plans differ only in shape, and the
        cheapest plan for a subset is always built from the cheapest plans for its parts. The search above estimates each
        join from the table it adds, which can give the same tables a different size in a different order; on this query
        the two agree on the cheapest left-deep plan.
      </p>

      <h3 className="mt-2 text-label font-semibold text-ink">Where a bushy plan wins</h3>
      <p className="text-label leading-relaxed text-ink-dim">
        Four tables joined by foreign keys, each from the bigger table to the smaller. Pick a shape and the sizes.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Shape
          <div className="flex gap-1" role="radiogroup" aria-label="Join graph shape">
            {GRAPH_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={shape === s}
                onClick={() => { setShape(s); }}
                className={`${segBase} ${shape === s ? segOn : segOff}`}
              >
                {SHAPE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        {EXPLORER_TABLES.map((name, i) => (
          <label key={name} className="flex flex-col gap-1 text-label text-ink-dim">
            Rows in {name}
            <select
              value={sizes[i]}
              onChange={(e) => {
                const value = Number(e.target.value);
                setSizes((cur) => cur.map((v, k) => (k === i ? value : v)));
              }}
              className={inputField}
            >
              {EXPLORER_SIZES.map((size) => (
                <option key={size} value={size}>
                  {fmt(size)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          className={btnSecondary}
          onClick={() => {
            setShape(TWO_PAIRS.shape);
            setSizes(TWO_PAIRS.sizes);
          }}
        >
          Two pairs
        </button>
      </div>
      <Winners search={explored} label="The chosen graph's cheapest plans" />

      <p className="text-label leading-relaxed text-ink-dim">
        Every graph these menus make, searched both ways ({fmt(sweep.graphs)} of them): a bushy plan is cheaper in{' '}
        <span className="tabular-nums text-ink">{fmt(sweep.bushyCheaper)}</span> —{' '}
        {fmt(sweep.byShape.chain.bushyCheaper)} chains and {fmt(sweep.byShape.star.bushyCheaper)} stars —{' '}
        {fmt(sweep.twoPairs)} of them splitting the four tables into two pairs, and never by more than{' '}
        <span className="tabular-nums text-ink">{sweep.best ? sweep.best.ratio.toFixed(2) : '1.00'}×</span>
        {sweep.best && (
          <>
            {' '}
            (a {sweep.best.shape} of {sweep.best.sizes.map(fmt).join(', ')} rows,{' '}
            <span className="font-mono text-ink">{treeText(sweep.best.tree)}</span>)
          </>
        )}
        . Under nested loops a bushy plan has one thing to offer: a small joined result read for every outer row where a
        left-deep plan must read a stored table. System R searched left-deep plans only, and by this measure gave up
        little — a bushy plan earns more with hash joins, or with two machines to build its two halves at once.
      </p>
      {sweep.best && (
        <div>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => {
              setShape(sweep.best!.shape);
              setSizes(sweep.best!.sizes);
            }}
          >
            Show the biggest win
          </button>
        </div>
      )}
    </section>
  );
}
