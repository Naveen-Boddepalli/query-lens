import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  costOfOrder,
  createJoinOrderDemoDatabase,
  DEFAULT_ENGINE_OPTIONS,
  joinGraphFromAst,
  parse,
  runJoinOrderDP,
  writtenOrderFromAst,
} from '../../engine/index.ts';
import type { JoinOrderCandidate, SubsetPlan } from '../../engine/index.ts';
import { DataView } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, panelSurface, pill } from '../../ui/primitives.ts';

/**
 * The join-order standalone (plan.md §25.4 C4): Selinger-style dynamic programming over the **subset lattice**.
 * For n tables there are `2^n - 1` non-empty subsets; the cheapest way to left-deep-join every table in a subset
 * is built up from the cheapest way to join every smaller subset one table down. `src/engine/planner/joinOrder.ts`
 * is the real algorithm this page just renders — nothing here recomputes a cost of its own.
 *
 * Built visualization-only (plan.md §25.4 C4's own scoping decision), and still exactly that for a chain with a
 * `LEFT JOIN` anywhere in it: `LEFT JOIN` is not commutative or associative in general, so real execution never
 * reorders one, and this page only ever shows what the DP *would* have chosen, beside the real, unchanged plan.
 * **The demo query below is a plain chain of inner `JOIN`s, though** (plan.md §25.4 C5 slice 3) — for exactly
 * that shape, the Playground (and everywhere else) now actually *runs* the DP's own answer: `FROM departments
 * JOIN employees JOIN timesheets JOIN projects`, not the "hub, then each branch" order written below. This page
 * still exists because the DP's *reasoning* — the whole subset lattice, every candidate it weighed for each one,
 * not just the winner — is worth seeing regardless of whether a given query gets to use it for real.
 *
 * The demo data (`createJoinOrderDemoDatabase`) is a tree, not a chain: `departments` is the hub, connecting to
 * both `employees` and `projects`; `timesheets` hangs off `employees` alone. Written the "natural" way — hub
 * first, then each branch in turn — it costs about 5× the DP-optimal order, because visiting `projects` before
 * drilling into `employees` → `timesheets` lets the *other* branch's join land against an already-larger
 * intermediate result. `seed.ts`'s own doc comment on the dataset has the exact figures this was tuned against.
 */

const DEMO_SQL =
  'SELECT * FROM departments\n' +
  '  JOIN projects ON departments.id = projects.deptId\n' +
  '  JOIN employees ON departments.id = employees.deptId\n' +
  '  JOIN timesheets ON employees.id = timesheets.employeeId';

const DB = createJoinOrderDemoDatabase();
const PARSED = parse(DEMO_SQL);
if (!PARSED.ok) throw new Error(`unreachable: the join-order demo query must parse — ${PARSED.error.message}`);
const AST = PARSED.ast;

const { nodes: GRAPH_NODES, edges: GRAPH_EDGES } = joinGraphFromAst(AST, DB.tables, DEFAULT_ENGINE_OPTIONS.rowsPerPage);
const WRITTEN_ORDER = writtenOrderFromAst(AST);
const WRITTEN_COST = costOfOrder(GRAPH_NODES, GRAPH_EDGES, WRITTEN_ORDER);
const DP_RESULT = runJoinOrderDP(GRAPH_NODES, GRAPH_EDGES);
const TABLE_NAMES = GRAPH_NODES.map((n) => n.name);

const plural = (n: number, s: string) => `${String(n)} ${s}${n === 1 ? '' : 's'}`;
const fmt = (n: number) => n.toLocaleString('en-US');

/** Every non-empty subset, grouped by size — one row per lattice "level," smallest first. */
function subsetsByLevel(subsets: ReadonlyMap<number, SubsetPlan>, n: number): SubsetPlan[][] {
  const levels: SubsetPlan[][] = Array.from({ length: n + 1 }, () => []);
  for (const plan of subsets.values()) levels[plan.tables.length]!.push(plan);
  for (const level of levels) level.sort((a, b) => a.mask - b.mask);
  return levels.slice(1); // level 0 (the empty subset) never exists
}

function short(name: string): string {
  return name.slice(0, 4);
}

const FULL_MASK = (1 << TABLE_NAMES.length) - 1;

export function JoinOrderToolPage() {
  const [selectedMask, setSelectedMask] = useState<number>(FULL_MASK);
  const [customOrder, setCustomOrder] = useState<string[]>([]);

  const levels = useMemo(() => subsetsByLevel(DP_RESULT.subsets, TABLE_NAMES.length), []);
  const selected = DP_RESULT.subsets.get(selectedMask) ?? DP_RESULT.subsets.get(FULL_MASK)!;

  const customCost = useMemo(
    () => (customOrder.length > 0 ? costOfOrder(GRAPH_NODES, GRAPH_EDGES, customOrder) : null),
    [customOrder],
  );

  const ratio = WRITTEN_COST.pages / DP_RESULT.winner.pages;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Join order">
        A query with more than one <code className="font-mono text-ink">JOIN</code> can join its tables in
        several orders and still answer the same question — but nested-loop&rsquo;s own cost,{' '}
        <code className="font-mono text-ink">left.pages + left.rows × right.pages</code>, is not the same
        number for each one. Selinger&rsquo;s dynamic-programming algorithm finds the cheapest order by building
        up the cheapest way to join every <em>subset</em> of the tables, smallest first — the lattice below is
        every subset it considered, not just the winner.
      </PageHeader>

      <div className={`${panelSurface} p-4`}>
        <p className="mb-2 text-label font-medium text-ink-dim">the demo query</p>
        <pre className="overflow-x-auto whitespace-pre rounded-lg bg-surface-3 p-3 font-mono text-label text-ink">
          {DEMO_SQL}
        </pre>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={`${panelSurface} p-4`}>
          <p className="text-label font-medium text-ink-dim">written order</p>
          <p className="mt-1 font-mono text-body text-ink">{WRITTEN_ORDER.join(' → ')}</p>
          <p className="mt-2 text-label text-ink-dim">
            <span className="tabular-nums text-ink">{fmt(WRITTEN_COST.pages)}</span> estimated pages
          </p>
        </div>
        <div className={`${panelSurface} p-4 ring-1 ring-accent/40`}>
          <p className="text-label font-medium text-ink-dim">DP&rsquo;s suggestion</p>
          <p className="mt-1 font-mono text-body text-ink">{DP_RESULT.winner.tables.join(' → ')}</p>
          <p className="mt-2 text-label text-ink-dim">
            <span className="tabular-nums text-ink">{fmt(DP_RESULT.winner.pages)}</span> estimated pages
            {ratio >= 1.05 && (
              <>
                {' — '}
                <span className="text-accent">{ratio.toFixed(1)}× cheaper</span>
              </>
            )}
          </p>
        </div>
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Both are estimates from the same cost model the rest of the app uses — this page never runs a query, it
        only costs hypothetical ones. The demo query above is a plain chain of inner JOINs, though (plan.md §25.4
        C5 slice 3), so unlike a chain with a LEFT JOIN in it, this <em>is</em> what actually runs — in the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>{' '}
        and everywhere else. A LEFT JOIN is not commutative, so a chain with one in it is never reordered for
        real, and stays exactly this: a second opinion, shown beside the plan that actually runs.
      </p>

      <div className={`${panelSurface} p-4`}>
        <p className="mb-2 text-label font-medium text-ink-dim">try your own order</p>
        <div className="flex flex-wrap items-center gap-2">
          {TABLE_NAMES.map((name) => {
            const used = customOrder.includes(name);
            return (
              <button
                key={name}
                type="button"
                disabled={used}
                onClick={() => { setCustomOrder((cur) => [...cur, name]); }}
                className={`${pill} ${used ? 'opacity-30' : 'cursor-pointer hover:border-ink-dim/50'}`}
              >
                {name}
              </button>
            );
          })}
          <button type="button" onClick={() => { setCustomOrder([]); }} className={btnSecondary}>
            Reset
          </button>
        </div>
        <p className="mt-3 text-label text-ink-dim">
          {customOrder.length === 0 ? (
            'Click tables in the order you’d join them.'
          ) : (
            <>
              <span className="font-mono text-ink">{customOrder.join(' → ')}</span>
              {customOrder.length === TABLE_NAMES.length && customCost && (
                <>
                  {' — '}
                  <span className="tabular-nums text-ink">{fmt(customCost.pages)}</span> estimated pages
                  {customCost.pages > DP_RESULT.winner.pages * 1.05 && (
                    <> ({(customCost.pages / DP_RESULT.winner.pages).toFixed(1)}× DP&rsquo;s own cost)</>
                  )}
                  {customCost.pages <= DP_RESULT.winner.pages * 1.05 && <> — you found the optimum too</>}
                </>
              )}
            </>
          )}
        </p>
      </div>

      <DataView
        caption="Every subset of the tables, with its cheapest plan's page cost"
        rows={levels.flat()}
        keyOf={(r) => String(r.mask)}
        columns={[
          { header: 'Subset', cell: (r) => r.tables.map(short).join(', ') },
          { header: 'Tables', cell: (r) => r.tables.length },
          { header: 'Pages', cell: (r) => fmt(r.pages) },
        ]}
      >
        <div className="flex flex-col gap-3">
          {levels.map((subsetsAtLevel, i) => (
            <LatticeLevel
              key={i}
              level={i + 1}
              subsets={subsetsAtLevel}
              selectedMask={selected.mask}
              onSelect={setSelectedMask}
            />
          ))}
        </div>
      </DataView>

      <SubsetDetail plan={selected} />

      <p className="text-label leading-relaxed text-ink-dim">
        No edge between two tables never means "forbidden," only "expensive": a cross join (no shared join
        column, so no row is ever excluded) is always one of the candidates a subset considers — it just almost
        always loses on cost. Restricted to left-deep orders on purpose: the engine&rsquo;s own{' '}
        <Link to="/docs/reference/limits#join" className="underline underline-offset-2 hover:text-ink">
          <code className="font-mono text-ink">JOIN</code> chains
        </Link>{' '}
        only ever run left-deep, so a bushy plan this page might otherwise consider is one nothing could
        actually execute.
      </p>
    </div>
  );
}

function LatticeLevel({
  level,
  subsets,
  selectedMask,
  onSelect,
}: {
  level: number;
  subsets: readonly SubsetPlan[];
  selectedMask: number;
  onSelect: (mask: number) => void;
}) {
  return (
    <div className={`${panelSurface} p-3`}>
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <span className="font-medium text-ink">
          {level} table{level === 1 ? '' : 's'}
        </span>
        <span className="text-ink-dim">{plural(subsets.length, 'subset')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {subsets.map((plan) => {
          const isSelected = plan.mask === selectedMask;
          return (
            <button
              key={plan.mask}
              type="button"
              onClick={() => { onSelect(plan.mask); }}
              aria-pressed={isSelected}
              className={`flex flex-col gap-1 rounded-lg border p-2 text-left text-label transition ${
                isSelected ? 'border-accent bg-accent-soft ring-2 ring-accent' : 'border-edge bg-surface-3 hover:border-ink-dim/50'
              }`}
            >
              <span className="font-mono text-ink">{plan.tables.map(short).join(',')}</span>
              <span className="tabular-nums text-ink-dim">{fmt(plan.pages)} pages</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubsetDetail({ plan }: { plan: SubsetPlan }) {
  const sorted = [...plan.candidates].sort((a, b) => a.pages - b.pages);
  return (
    <div className={`${panelSurface} p-4`}>
      <p className="text-label font-medium text-ink-dim">
        {plan.tables.length === 1 ? 'a single table — nothing to choose' : "this subset's own choice"}
      </p>
      <p className="mt-1 font-mono text-body text-ink">{plan.tables.join(' → ')}</p>
      <p className="mt-1 text-label text-ink-dim">
        <span className="tabular-nums text-ink">{fmt(plan.rows)}</span> estimated rows,{' '}
        <span className="tabular-nums text-ink">{fmt(plan.pages)}</span> estimated pages
      </p>

      {sorted.length > 0 && (
        <>
          <p className="mt-3 text-label text-ink-dim">
            every table the DP tried adding last, cheapest first — this is the recurrence itself, not just its answer:
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {sorted.map((c) => (
              <CandidateRow key={c.addedTable} candidate={c} winner={c.addedTable === plan.tables.at(-1)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CandidateRow({ candidate, winner }: { candidate: JoinOrderCandidate; winner: boolean }) {
  return (
    <li className={`flex items-center gap-2 rounded-md px-2 py-1 text-label ${winner ? 'bg-accent-soft' : ''}`}>
      <span aria-hidden className={winner ? 'text-accent' : 'text-ink-dim/40'}>
        {winner ? '✓' : '·'}
      </span>
      <span className="font-mono text-ink">+{candidate.addedTable}</span>
      <span className="tabular-nums text-ink-dim">{fmt(candidate.pages)} pages</span>
      {!candidate.viaEdge && <span className="text-ink-dim/70">— no shared column, a cross join</span>}
    </li>
  );
}
