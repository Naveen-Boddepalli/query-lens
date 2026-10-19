import { useMemo, useState } from 'react';
import { DISPATCHES, PARALLEL_LIMITS } from '../../engine/parallel.ts';
import type { Dispatch, ParallelResult } from '../../engine/parallel.ts';
import { DataView } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import {
  DISPATCH_LABELS,
  isDispatch,
  PARALLEL_DEFAULTS,
  PARALLEL_QUERIES,
  parallelRun,
  parseSpeeds,
} from '../../ui/parallelPresets.ts';
import { inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The parallel-execution standalone (plan.md §27.5 P1): a scan, a filter and an aggregate on the transactions preset,
 * cut into morsels and run by *N* workers whose speeds are a script you set. `engine/parallel.ts` is the model; this
 * page draws its timeline, worker by worker, and measures the speedup in ticks.
 *
 * URL state: `q` (query), `w` (workers), `d` (dispatch), `m` (pages per morsel), `s` (one speed digit per worker).
 */

const W = 720;
const LANE = 26;
const fmt = (n: number) => n.toLocaleString('en-US');

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const query = PARALLEL_QUERIES.some((q) => q.id === p.get('q')) ? p.get('q')! : PARALLEL_DEFAULTS.query;
  const workers = clampInt(p.get('w'), PARALLEL_LIMITS.minWorkers, PARALLEL_LIMITS.maxWorkers, PARALLEL_DEFAULTS.workers);
  const raw = p.get('d');
  const dispatch: Dispatch = isDispatch(raw) ? raw : PARALLEL_DEFAULTS.dispatch;
  const morselPages = clampInt(p.get('m'), PARALLEL_LIMITS.minMorselPages, PARALLEL_LIMITS.maxMorselPages, PARALLEL_DEFAULTS.morselPages);
  const speeds = parseSpeeds(p.get('s'), workers) ?? Array.from({ length: workers }, (_, i) => PARALLEL_DEFAULTS.speeds[i] ?? 1);
  return { query, workers, dispatch, morselPages, speeds };
}

const INITIAL = readInitial();

function Timeline({ result, workers }: { result: ParallelResult; workers: number }) {
  const sx = (t: number) => 70 + (t / Math.max(1, result.ticks)) * (W - 80);
  const height = workers * LANE + 24;
  return (
    <svg viewBox={`0 0 ${String(W)} ${String(height)}`} className="h-auto w-full" role="img" aria-label={`${String(workers)} workers over ${fmt(result.ticks)} ticks: ${String(result.runs.length)} morsels, ${String(result.steals)} stolen, then the merge`}>
      {Array.from({ length: workers }, (_, w) => (
        <g key={w}>
          <text x={4} y={w * LANE + 17} className="fill-current text-[11px] text-ink-dim">
            worker {w + 1}
          </text>
          <line x1={70} x2={W - 10} y1={w * LANE + 22} y2={w * LANE + 22} className="stroke-edge" strokeWidth={0.5} />
        </g>
      ))}
      {result.runs.map((run) => (
        <rect
          key={run.morsel}
          x={sx(run.start)}
          y={run.worker * LANE + 4}
          width={Math.max(0.8, sx(run.end) - sx(run.start))}
          height={16}
          className={run.stolenFrom !== undefined ? 'fill-evict/60' : run.remotePages > 0 ? 'fill-miss/50' : 'fill-accent/60'}
        >
          <title>
            morsel {run.morsel + 1}, pages {result.morsels[run.morsel]!.firstPage}–{result.morsels[run.morsel]!.lastPage}: ticks {run.start}–{run.end}
          </title>
        </rect>
      ))}
      <rect
        x={sx(result.merge.start)}
        y={result.merge.worker * LANE + 4}
        width={Math.max(1.5, sx(result.merge.end) - sx(result.merge.start))}
        height={16}
        className="fill-ink"
      />
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={sx(f * result.ticks)} y={height - 4} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="fill-current text-[10px] text-ink-dim">
          {fmt(Math.round(f * result.ticks))}
        </text>
      ))}
    </svg>
  );
}

export function ParallelToolPage() {
  const [query, setQuery] = useState(INITIAL.query);
  const [workers, setWorkers] = useState(INITIAL.workers);
  const [dispatch, setDispatch] = useState<Dispatch>(INITIAL.dispatch);
  const [morselPages, setMorselPages] = useState(INITIAL.morselPages);
  const [speeds, setSpeeds] = useState<number[]>(INITIAL.speeds);
  // The speeds of the workers in use, as a string: one digit each, which is also how the link carries them.
  const profile = Array.from({ length: workers }, (_, k) => speeds[k] ?? 1).join('');
  const active = [...profile].map(Number);

  const result = useMemo(() => parallelRun(query, workers, dispatch, morselPages, [...profile].map(Number)), [query, workers, dispatch, morselPages, profile]);
  const sweep = useMemo(
    () =>
      DISPATCHES.map((d) => ({
        dispatch: d,
        speedups: Array.from({ length: PARALLEL_LIMITS.maxWorkers }, (_, i) => {
          const n = i + 1;
          const s = Array.from({ length: n }, (_, k) => Number(profile[k] ?? 1));
          return parallelRun(query, n, d, morselPages, s).speedup;
        }),
      })),
    [query, morselPages, profile],
  );

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('q', query);
    p.set('w', String(workers));
    p.set('d', dispatch);
    p.set('m', String(morselPages));
    p.set('s', profile);
    return p.toString();
  }, [query, workers, dispatch, morselPages, profile]);
  useAddressBarQuery(shareQuery);

  const about = PARALLEL_QUERIES.find((q) => q.id === query)!;
  const remote = result.runs.reduce((s, r) => s + r.remotePages, 0);
  const runRows = [...result.runs].sort((a, b) => a.start - b.start);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Parallel execution">
        A scan, a filter and an aggregate, cut into <em>morsels</em> of a few pages and run by several workers at once —
        each aggregating what it reads into a partial result, then one of them merging the partials. How the morsels are
        handed out decides whether the workers finish together. Time here is ticks, counted, and how fast each worker is,
        is yours to set: nothing runs in parallel in your browser, so the same settings always draw the same timeline.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Query">
            {PARALLEL_QUERIES.map((q) => (
              <button key={q.id} type="button" role="radio" aria-checked={query === q.id} onClick={() => { setQuery(q.id); }} className={`${segBase} ${query === q.id ? segOn : segOff}`}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Dispatch
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Dispatch">
            {DISPATCHES.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={dispatch === d} onClick={() => { setDispatch(d); }} className={`${segBase} ${dispatch === d ? segOn : segOff}`}>
                {DISPATCH_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Workers
          <select value={workers} onChange={(e) => { setWorkers(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: PARALLEL_LIMITS.maxWorkers }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
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
            disabled={dispatch === 'static'}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= PARALLEL_LIMITS.minMorselPages && v <= PARALLEL_LIMITS.maxMorselPages) setMorselPages(v);
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
      </div>

      <fieldset className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <legend className="px-1 text-label text-ink-dim">Ticks per unit of work — 1 is full speed, 3 three times slower</legend>
        {active.map((s, w) => (
          <label key={w} className="flex flex-col gap-1 text-label text-ink-dim">
            Worker {w + 1}
            <select
              value={s}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSpeeds((cur) => {
                  const next = [...cur];
                  while (next.length < workers) next.push(1);
                  next[w] = v;
                  return next;
                });
              }}
              className={inputField}
            >
              {Array.from({ length: PARALLEL_LIMITS.maxSpeed }, (_, i) => i + 1).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
        <p className="font-mono text-label text-ink">{about.sql}</p>
        <p className="text-label text-ink-dim">{about.about}</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-label sm:grid-cols-5">
          <div>
            <dt className="text-ink-dim">speedup</dt>
            <dd className="tabular-nums text-body text-ink">
              <span role="status">{result.speedup.toFixed(2)}×</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-dim">ticks</dt>
            <dd className="tabular-nums text-body text-ink">{fmt(result.ticks)}</dd>
          </div>
          <div>
            <dt className="text-ink-dim">one worker alone</dt>
            <dd className="tabular-nums text-body text-ink">{fmt(result.serialTicks)}</dd>
          </div>
          <div>
            <dt className="text-ink-dim">morsels, stolen</dt>
            <dd className="tabular-nums text-body text-ink">
              {fmt(result.morsels.length)}, {fmt(result.steals)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-dim">pages read remotely</dt>
            <dd className="tabular-nums text-body text-ink">
              {fmt(remote)} of {fmt(result.pages)}
            </dd>
          </div>
        </dl>
      </div>

      <DataView
        caption="Every morsel, in the order it started"
        rows={runRows}
        keyOf={(r) => String(r.morsel)}
        columns={[
          { header: 'Morsel', cell: (r) => r.morsel + 1 },
          { header: 'Worker', cell: (r) => r.worker + 1 },
          { header: 'Pages', cell: (r) => `${String(result.morsels[r.morsel]!.firstPage)}–${String(result.morsels[r.morsel]!.lastPage)}` },
          { header: 'Start', cell: (r) => r.start },
          { header: 'End', cell: (r) => r.end },
          { header: 'Remote pages', cell: (r) => r.remotePages },
          { header: 'Stolen from', cell: (r) => (r.stolenFrom === undefined ? '—' : `worker ${String(r.stolenFrom + 1)}`) },
        ]}
      >
        <div className={`${panelSurface} p-4`}>
          <Timeline result={result} workers={workers} />
          <p className="mt-1 text-label text-ink-dim">
            Each bar is a morsel: teal read only the worker&rsquo;s own pages, amber read some of another&rsquo;s (a second
            tick each), red was stolen from another worker&rsquo;s queue. The dark bar at the end is the merge of{' '}
            {result.merge.partials.filter((p) => p > 0).length} partial results — {fmt(result.merge.end - result.merge.start)}{' '}
            ticks no number of workers shortens. Worker idle time:{' '}
            {result.idle.map((idle, w) => `${String(w + 1)}: ${fmt(idle)}`).join(', ')}.
          </p>
        </div>
      </DataView>

      <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
        <h2 className="text-body font-semibold text-ink">Speedup by workers</h2>
        <p className="text-label text-ink-dim">
          The same query and morsel size with one to eight workers, the speeds above for the first ones and full speed for
          any added.
        </p>
        <ScrollRegion label="Speedup by workers and dispatch" className="overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="text-left text-ink-dim">
                <th scope="col" className="py-1 pr-3 font-medium">Dispatch</th>
                {Array.from({ length: PARALLEL_LIMITS.maxWorkers }, (_, i) => (
                  <th key={i} scope="col" className="py-1 pr-3 text-right font-medium">
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums text-ink">
              {sweep.map((row) => (
                <tr key={row.dispatch} className="border-t border-edge">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {DISPATCH_LABELS[row.dispatch]}
                  </th>
                  {row.speedups.map((s, i) => (
                    <td key={i} className={`py-1 pr-3 text-right ${i + 1 === workers && row.dispatch === dispatch ? 'font-semibold text-accent' : ''}`}>
                      {s.toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </div>

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-2 text-body font-semibold text-ink">The answer</h2>
        <p className="mb-2 text-label text-ink-dim">The partial results merged — the same rows the engine returns running the query alone.</p>
        <table className="text-label">
          <thead>
            <tr className="text-left text-ink-dim">
              {result.columns.map((c) => (
                <th key={c} scope="col" className="py-1 pr-4 font-mono font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink">
            {result.rows.map((row, i) => (
              <tr key={i} className="border-t border-edge">
                {result.columns.map((c) => (
                  <td key={c} className="py-1 pr-4 font-mono">
                    {String(row[c] ?? 'NULL')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
