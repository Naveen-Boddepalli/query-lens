import { useMemo, useState } from 'react';
import { DISPATCHES, PARALLEL_LIMITS } from '../../engine/parallel.ts';
import type { Dispatch, ParallelResult } from '../../engine/parallel.ts';
import { EXCHANGE_LIMITS } from '../../engine/exchange.ts';
import type { JoinExchange } from '../../engine/exchange.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { ExchangeSection } from '../../ui/ExchangeSection.tsx';
import { JOIN_QUERIES } from '../../ui/exchangePresets.ts';
import {
  DISPATCH_LABELS,
  isDispatch,
  PARALLEL_DEFAULTS,
  PARALLEL_QUERIES,
  parallelRun,
  parseSpeeds,
} from '../../ui/parallelPresets.ts';
import { inputField } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  hintIdFor,
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
 * The parallel-execution standalone (plan.md §27.5 P1): a scan, a filter and an aggregate on the transactions preset,
 * cut into morsels and run by *N* workers whose speeds are a script you set. `engine/parallel.ts` is the model; this
 * page draws its timeline, worker by worker, and measures the speedup in ticks.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): query, dispatch and workers (with each one's speed) in the
 * inspector, the speedup in the readout, the timeline on the stage with a table view, and the speedup sweep, the
 * exchange section and the answer below.
 *
 * URL state: `q` (query), `w` (workers), `d` (dispatch), `m` (pages per morsel), `s` (one speed digit per worker); and
 * for the exchange section (plan.md §27.5 P2), `jq` (join), `jw` (workers) and `jx` (broadcast or repartition).
 */

const W = 720;
const LANE = 26;
const fmt = (n: number) => n.toLocaleString('en-US');
const DISPATCH_SHORT: Record<Dispatch, string> = { static: 'Static', shared: 'Shared', stealing: 'Stealing' };
const DISPATCH_HINTS: Record<Dispatch, string> = {
  static: 'Static ranges: each worker gets one slice of the pages up front.',
  shared: 'Shared queue: an idle worker takes the next morsel from one queue.',
  stealing: 'Work stealing: each worker has its own queue and robs a busy one when it runs dry.',
};

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
  const joinQuery = JOIN_QUERIES.some((q) => q.id === p.get('jq')) ? p.get('jq')! : 'small-big';
  const joinWorkers = clampInt(p.get('jw'), EXCHANGE_LIMITS.minWorkers, EXCHANGE_LIMITS.maxWorkers, 4);
  const joinStrategy: JoinExchange = p.get('jx') === 'repartition' ? 'repartition' : 'broadcast';
  return { query, workers, dispatch, morselPages, speeds, joinQuery, joinWorkers, joinStrategy };
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
  const [joinQuery, setJoinQuery] = useState(INITIAL.joinQuery);
  const [joinWorkers, setJoinWorkers] = useState(INITIAL.joinWorkers);
  const [joinStrategy, setJoinStrategy] = useState<JoinExchange>(INITIAL.joinStrategy);
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
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
    p.set('jq', joinQuery);
    p.set('jw', String(joinWorkers));
    p.set('jx', joinStrategy);
    return p.toString();
  }, [query, workers, dispatch, morselPages, profile, joinQuery, joinWorkers, joinStrategy]);
  useAddressBarQuery(shareQuery);

  const about = PARALLEL_QUERIES.find((q) => q.id === query)!;
  const remote = result.runs.reduce((s, r) => s + r.remotePages, 0);
  const runRows = [...result.runs].sort((a, b) => a.start - b.start);

  const setSpeed = (w: number, v: number) => {
    setSpeeds((cur) => {
      const next = [...cur];
      while (next.length < workers) next.push(1);
      next[w] = v;
      return next;
    });
  };
  const partials = result.merge.partials.filter((p) => p > 0).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="parallel"
            title="Parallel execution"
            summary="Cut a scan into morsels for several workers, set how fast each one is, and see how the dispatch decides when they finish."
            about={
              <p>
                A scan, a filter and an aggregate, cut into <em>morsels</em> of a few pages and run by several workers at
                once, each aggregating what it reads into a partial result, then one of them merging the partials. How the
                morsels are handed out decides whether the workers finish together. Time here is ticks, counted, and how
                fast each worker is, is yours to set: nothing runs in parallel in your browser, so the same settings always
                draw the same timeline.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${about.label} · ${plural(workers, 'worker')} · ${DISPATCH_LABELS[dispatch].toLowerCase()}`}>
            <ControlGroup legend="Run">
              <ControlRow label="Query" labelId="par-query" stacked hint={about.about}>
                <Segmented
                  labelledBy="par-query"
                  describedBy={hintIdFor('par-query')}
                  tone="stage"
                  value={query}
                  onChange={setQuery}
                  options={PARALLEL_QUERIES.map((q) => ({ value: q.id, label: q.label }))}
                />
              </ControlRow>
              <ControlRow label="Dispatch" labelId="par-dispatch" stacked hint="How the morsels reach the workers.">
                <Segmented
                  labelledBy="par-dispatch"
                  describedBy={hintIdFor('par-dispatch')}
                  tone="stage"
                  value={dispatch}
                  onChange={setDispatch}
                  options={DISPATCHES.map((d) => ({ value: d, label: DISPATCH_SHORT[d], ariaLabel: DISPATCH_LABELS[d] }))}
                />
              </ControlRow>
              {dispatch === 'static' ? (
                <p className="text-label text-ink-dim">Static ranges hand each worker one slice up front, so there are no morsels to size.</p>
              ) : (
                <ControlRow label="Pages per morsel" htmlFor="par-m">
                  <Stepper id="par-m" value={morselPages} min={PARALLEL_LIMITS.minMorselPages} max={PARALLEL_LIMITS.maxMorselPages} unit="pages" onChange={setMorselPages} />
                </ControlRow>
              )}
            </ControlGroup>
            <ControlGroup legend="Workers">
              <ControlRow label="Workers" htmlFor="par-w">
                <Stepper id="par-w" value={workers} min={PARALLEL_LIMITS.minWorkers} max={PARALLEL_LIMITS.maxWorkers} unit="workers" onChange={setWorkers} />
              </ControlRow>
              <div className="flex flex-col gap-2">
                <p id="par-speeds" className="text-label text-ink-dim">
                  Ticks per unit of work for each: 1 is full speed, 3 three times slower.
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {active.map((v, w) => (
                    <label key={w} className="flex items-center justify-between gap-2 text-label text-ink-dim">
                      Worker {w + 1}
                      <select
                        value={v}
                        aria-describedby="par-speeds"
                        onChange={(e) => { setSpeed(w, Number(e.target.value)); }}
                        className={`${inputField} w-14`}
                      >
                        {Array.from({ length: PARALLEL_LIMITS.maxSpeed }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Speedup', value: `${result.speedup.toFixed(2)}×`, sub: 'against one worker alone' },
              { label: 'Ticks', value: fmt(result.ticks), sub: `${fmt(result.serialTicks)} for one worker` },
              { label: 'Morsels', value: fmt(result.morsels.length), sub: `${fmt(result.steals)} stolen` },
              { label: 'Pages read remotely', value: fmt(remote), sub: `of ${fmt(result.pages)}` },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Timeline"
            legend={`${plural(workers, 'worker')}, in ticks`}
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            <p className="mb-3 font-mono text-label break-words text-ink">{about.sql}</p>
            {view === 'diagram' ? (
              <>
                <p className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-label text-ink-dim">
                  <Key className="bg-accent/60">own pages</Key>
                  <Key className="bg-miss/50">some remote</Key>
                  <Key className="bg-evict/60">stolen</Key>
                  <Key className="bg-ink">merge</Key>
                </p>
                <ScrollRegion label="Timeline, worker by worker" className="overflow-x-auto">
                  <div className="min-w-[36rem]">
                    <Timeline result={result} workers={workers} />
                  </div>
                </ScrollRegion>
              </>
            ) : (
              <DataTable
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
              />
            )}
          </StagePanel>
        }
        narration={`${DISPATCH_HINTS[dispatch]} The merge of ${plural(partials, 'partial result')} takes ${plural(result.merge.end - result.merge.start, 'tick')} that no number of workers shortens. Idle ticks by worker: ${result.idle.map((idle, w) => `${String(w + 1)}: ${fmt(idle)}`).join(', ')}.`}
      >
        <ToolSection
          title="Speedup by workers"
          description="The same query and morsel size with one to eight workers, the speeds above for the first ones and full speed for any added."
        >
          <ScrollRegion label="Speedup by workers and dispatch" className="overflow-x-auto" stickyFirst>
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
              <tbody className="text-ink tabular-nums">
                {sweep.map((row) => (
                  <tr key={row.dispatch} className="border-t border-edge/60">
                    <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">
                      {DISPATCH_LABELS[row.dispatch]}
                    </th>
                    {row.speedups.map((sp, i) => (
                      <td key={i} className={`py-1 pr-3 text-right ${i + 1 === workers && row.dispatch === dispatch ? 'font-semibold text-accent' : ''}`}>
                        {sp.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </ToolSection>
        {/* plan.md §27.5 P2: exchanges, and a parallel hash join's two ways of getting rows together. */}
        <ExchangeSection
          query={joinQuery}
          workers={joinWorkers}
          strategy={joinStrategy}
          onQuery={setJoinQuery}
          onWorkers={setJoinWorkers}
          onStrategy={setJoinStrategy}
        />
        <ToolSection title="The answer" description="The partial results merged: the same rows the engine returns running the query alone.">
          <ScrollRegion label="The query's answer" className="overflow-x-auto">
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
              <tbody className="text-ink tabular-nums">
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-t border-edge/60">
                    {result.columns.map((c) => (
                      <td key={c} className="py-1 pr-4 font-mono">
                        {String(row[c] ?? 'NULL')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </ToolSection>
      </ToolShell>
    </div>
  );
}

function Key({ className, children }: { className: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${className}`} aria-hidden />
      {children}
    </span>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
