import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DISPATCHES, PARALLEL_LIMITS, runParallel } from '../engine/parallel.ts';
import type { Dispatch, ParallelResult } from '../engine/parallel.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../engine/types.ts';
import { COMPARE_DB, PARALLEL_COMPARE_QUERIES, parallelComparison } from './parallelComparison.ts';
import { DISPATCH_LABELS } from './parallelPresets.ts';
import { inputField, panelSurface, segBase, segOff, segOn } from './primitives.ts';
import { ScrollRegion } from './ScrollRegion.tsx';

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * plan.md §27.5 P3: one query's plan run serially and with *N* workers, side by side on `/compare` — the ticks, and
 * Amdahl's serial fraction measured from the run. Serially it is the engine's own run of its own plan; in parallel it is
 * `engine/parallel.ts`'s morsel model of the same scan, filter and aggregate.
 */

export function ParallelCompare({ initialQuery }: { initialQuery?: string | undefined }) {
  const [query, setQuery] = useState(PARALLEL_COMPARE_QUERIES.some((q) => q.id === initialQuery) ? initialQuery! : 'account');
  const [workers, setWorkers] = useState(8);
  const [dispatch, setDispatch] = useState<Dispatch>('stealing');
  const [morselPages, setMorselPages] = useState(16);
  const about = PARALLEL_COMPARE_QUERIES.find((q) => q.id === query)!;

  const { serial, scaling: s } = useMemo(() => parallelComparison(query, dispatch, morselPages), [query, dispatch, morselPages]);
  const parallel: ParallelResult = useMemo(() => {
    const r = runParallel(about.sql, COMPARE_DB, { workers, dispatch, morselPages, speeds: Array.from({ length: workers }, () => 1), rowsPerPage: DEFAULT_ENGINE_OPTIONS.rowsPerPage });
    if (!r.ok) throw new Error(r.error);
    return r;
  }, [about.sql, workers, dispatch, morselPages]);
  const point = s.points[workers - 1]!;
  const kf = s.points.slice(1).map((p) => p.karpFlatt ?? 0);
  const climbing = kf.length > 1 && kf.at(-1)! > kf[0]! * 1.5;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-label leading-relaxed text-ink-dim">
        The same query on the transactions preset, run once by the engine as its plan says, and by <em>N</em> workers as{' '}
        <Link to="/tools/parallel" className="underline underline-offset-2 hover:text-ink">
          the parallel tool
        </Link>{' '}
        models it: morsels of pages, a partial result per worker, one merge at the end. Ticks count the work — a page, a
        row aggregated, a morsel taken, a partial group merged — and every worker here is full speed.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Query">
            {PARALLEL_COMPARE_QUERIES.map((q) => (
              <button key={q.id} type="button" role="radio" aria-checked={query === q.id} onClick={() => { setQuery(q.id); }} className={`${segBase} ${query === q.id ? segOn : segOff}`}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Workers
          <select value={workers} onChange={(e) => { setWorkers(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: PARALLEL_LIMITS.maxWorkers - 1 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Dispatch
          <select value={dispatch} onChange={(e) => { setDispatch(e.target.value as Dispatch); }} className={inputField}>
            {DISPATCHES.map((d) => (
              <option key={d} value={d}>
                {DISPATCH_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Pages per morsel
          <input
            type="number"
            min={PARALLEL_LIMITS.minMorselPages}
            max={PARALLEL_LIMITS.maxMorselPages}
            value={morselPages}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= PARALLEL_LIMITS.minMorselPages && v <= PARALLEL_LIMITS.maxMorselPages) setMorselPages(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={`${panelSurface} p-4`}>
          <p className="text-label font-medium text-ink-dim">serially — the engine&rsquo;s own plan</p>
          <p className="mt-1 font-mono text-label break-words text-ink">{serial.plan}</p>
          <p className="mt-2 text-label text-ink-dim">
            <span className="tabular-nums text-body text-ink">{fmt(serial.ticks)}</span> ticks of work, {fmt(serial.rows)} rows out
          </p>
        </div>
        <div className={`${panelSurface} p-4 ring-1 ring-accent/40`}>
          <p className="text-label font-medium text-ink-dim">with {workers} workers</p>
          <p className="mt-1 font-mono text-label break-words text-ink">
            Merge ← {workers} × (partial aggregate ← {about.sql.includes('WHERE') ? 'filter ← ' : ''}morsels of transactions)
          </p>
          <p className="mt-2 text-label text-ink-dim">
            <span className="tabular-nums text-body text-ink">{fmt(parallel.ticks)}</span> ticks —{' '}
            <span role="status">{point.speedup.toFixed(2)}×</span> one worker running the same way, the merge{' '}
            {fmt(parallel.merge.end - parallel.merge.start)} of them
          </p>
        </div>
      </div>

      <ScrollRegion label="Scaling with the number of workers" className="overflow-x-auto">
        <table className="w-full text-label">
          <caption className="mb-1 text-left text-ink-dim">
            One to eight workers against one: the serial fraction measured from the one-worker run is{' '}
            {(s.serialFraction * 100).toFixed(2)}% (its merge)
          </caption>
          <thead>
            <tr className="text-left text-ink-dim">
              <th scope="col" className="py-1 pr-3 font-medium">Workers</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Ticks</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Speedup</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Amdahl predicts</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Efficiency</th>
              <th scope="col" className="py-1 text-right font-medium">Karp–Flatt serial fraction</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink">
            {s.points.map((p) => (
              <tr key={p.workers} className={`border-t border-edge ${p.workers === workers ? 'text-accent' : ''}`}>
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {p.workers}
                </th>
                <td className="py-1 pr-3 text-right">{fmt(p.ticks)}</td>
                <td className="py-1 pr-3 text-right">{p.speedup.toFixed(2)}×</td>
                <td className="py-1 pr-3 text-right">{p.amdahl.toFixed(2)}×</td>
                <td className="py-1 pr-3 text-right">{(p.efficiency * 100).toFixed(0)}%</td>
                <td className="py-1 text-right">{p.karpFlatt === null ? '—' : p.karpFlatt.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="text-label leading-relaxed text-ink-dim">
        Amdahl&rsquo;s law: if a fraction <em>f</em> of the work can only be done by one worker, <em>N</em> workers reach
        at most 1 / (<em>f</em> + (1 − <em>f</em>) / <em>N</em>). The Karp–Flatt column works <em>f</em> back out of each
        measured speedup. {climbing
          ? 'Here it climbs as workers are added: the serial part is not fixed. Every worker sees every group, so the merge has one partial result per worker to fold in — the more workers, the longer it takes — and dispatching and the last uneven morsels add their share.'
          : 'Here it stays close to flat: one fixed serial part — the merge — explains the run, as Amdahl’s law assumes, and the rest is the small cost of dispatching and of the last morsels finishing unevenly.'}
      </p>
    </div>
  );
}
