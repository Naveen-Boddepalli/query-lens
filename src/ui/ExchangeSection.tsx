import { useMemo } from 'react';
import { EXCHANGE_LIMITS, JOIN_EXCHANGES } from '../engine/exchange.ts';
import type { JoinExchange } from '../engine/exchange.ts';
import { EXCHANGE_LABELS, JOIN_QUERIES, joinRun } from './exchangePresets.ts';
import { inputField, panelSurface, segBase, segOff, segOn } from './primitives.ts';
import { ScrollRegion } from './ScrollRegion.tsx';

/**
 * plan.md §27.5 P2: exchange operators on `/tools/parallel` — a parallel hash join by broadcast or by repartitioning,
 * the rows each moves worker to worker, the ticks of each phase, and the same join the other way for comparison.
 * `engine/exchange.ts` is the model.
 */

const PHASE_WORDS = { exchange: 'exchange', build: 'build', probe: 'probe', gather: 'gather' } as const;
const fmt = (n: number) => n.toLocaleString('en-US');

export function ExchangeSection({
  query,
  workers,
  strategy,
  onQuery,
  onWorkers,
  onStrategy,
}: {
  query: string;
  workers: number;
  strategy: JoinExchange;
  onQuery: (id: string) => void;
  onWorkers: (n: number) => void;
  onStrategy: (s: JoinExchange) => void;
}) {
  const result = useMemo(() => joinRun(query, workers, strategy), [query, workers, strategy]);
  const other = useMemo(() => joinRun(query, workers, strategy === 'broadcast' ? 'repartition' : 'broadcast'), [query, workers, strategy]);
  const about = JOIN_QUERIES.find((q) => q.id === query)!;
  const total = Math.max(1, result.ticks);

  return (
    <section className={`${panelSurface} flex flex-col gap-3 p-4`} aria-labelledby="exchange-heading">
      <h2 id="exchange-heading" className="text-body font-semibold text-ink">
        Exchange: a parallel hash join
      </h2>
      <p className="text-label leading-relaxed text-ink-dim">
        Rows that must meet have to be on the same worker. An <em>exchange</em> gets them there: <strong>broadcast</strong>{' '}
        sends every row of one side to every worker, <strong>repartition</strong> sends each row to the worker its join key
        hashes to, and <strong>gather</strong> brings every worker&rsquo;s results to one. Each table starts spread over the
        workers in equal ranges; a tick moves a row, inserts one into a hash table, or looks one up, and a phase ends when its
        slowest worker does.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Join
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Join">
            {JOIN_QUERIES.map((q) => (
              <button key={q.id} type="button" role="radio" aria-checked={query === q.id} onClick={() => { onQuery(q.id); }} className={`${segBase} ${query === q.id ? segOn : segOff}`}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Exchange
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Exchange">
            {JOIN_EXCHANGES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={strategy === s} onClick={() => { onStrategy(s); }} className={`${segBase} ${strategy === s ? segOn : segOff}`}>
                {EXCHANGE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Join workers
          <select value={workers} onChange={(e) => { onWorkers(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: EXCHANGE_LIMITS.maxWorkers }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="font-mono text-label text-ink">{JOIN_QUERIES.find((q) => q.id === query)!.sql}</p>
      <p className="text-label text-ink-dim">
        {about.about} The hash table is built on <span className="font-mono text-ink">{result.build.table}</span> (
        {fmt(result.build.rows)} rows), the smaller side, and probed with{' '}
        <span className="font-mono text-ink">{result.probe.table}</span> ({fmt(result.probe.rows)}).
      </p>
      <p className="font-mono text-label text-ink-dim">{result.plan}</p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-label sm:grid-cols-4">
        <div>
          <dt className="text-ink-dim">speedup</dt>
          <dd className="tabular-nums text-body text-ink">
            <span role="status">{result.speedup.toFixed(2)}×</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-dim">ticks (one worker alone)</dt>
          <dd className="tabular-nums text-body text-ink">
            {fmt(result.ticks)} ({fmt(result.serialTicks)})
          </dd>
        </div>
        <div>
          <dt className="text-ink-dim">rows moved</dt>
          <dd className="tabular-nums text-body text-ink">{fmt(result.moved.total)}</dd>
        </div>
        <div>
          <dt className="text-ink-dim">{result.counting ? 'COUNT(*)' : 'rows out'}</dt>
          <dd className="tabular-nums text-body text-ink">{fmt(result.count)}</dd>
        </div>
      </dl>

      <div aria-hidden className="flex h-4 w-full overflow-hidden rounded-full bg-surface-3">
        {result.phases.map((p, i) => (
          <span
            key={p.name}
            className={['bg-miss/70', 'bg-accent/50', 'bg-accent', 'bg-evict/70'][i]}
            style={{ width: `${String((p.ticks / total) * 100)}%` }}
          />
        ))}
      </div>
      <p className="text-label text-ink-dim">
        {result.phases.map((p) => `${PHASE_WORDS[p.name]} ${fmt(p.ticks)}`).join(' · ')} ticks. The other way —{' '}
        {EXCHANGE_LABELS[other.strategy].toLowerCase()} — moves {fmt(other.moved.total)} rows and takes {fmt(other.ticks)}{' '}
        ticks, {other.speedup.toFixed(2)}×.
      </p>

      <ScrollRegion label="Rows each worker sent each other in the exchange" className="overflow-x-auto">
        <table className="text-label">
          <caption className="mb-1 text-left text-ink-dim">Rows sent in the exchange, from a worker (row) to a worker (column), and what each then holds</caption>
          <thead>
            <tr className="text-ink-dim">
              <th scope="col" className="py-1 pr-3 text-left font-medium">From \ to</th>
              {result.traffic.map((_, w) => (
                <th key={w} scope="col" className="py-1 pr-3 text-right font-medium">
                  {w + 1}
                </th>
              ))}
              <th scope="col" className="py-1 pr-3 text-right font-medium">Holds {result.build.table}</th>
              <th scope="col" className="py-1 text-right font-medium">Holds {result.probe.table}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink">
            {result.traffic.map((row, from) => (
              <tr key={from} className="border-t border-edge">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  worker {from + 1}
                </th>
                {row.map((x, to) => (
                  <td key={to} className={`py-1 pr-3 text-right ${from === to ? 'text-ink-dim' : ''}`}>
                    {from === to ? '·' : fmt(x)}
                  </td>
                ))}
                <td className="py-1 pr-3 text-right">{fmt(result.held.build[from]!)}</td>
                <td className={`py-1 text-right ${result.held.probe[from] === 0 ? 'text-evict' : ''}`}>{fmt(result.held.probe[from]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </section>
  );
}
