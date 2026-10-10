import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_PAGES,
  MAX_WAL_STEPS,
  cellsText,
  describeRecord,
  formatWalStep,
  runWal,
} from '../../engine/recovery/wal.ts';
import type { LogRecord, WalEffect, WalState, WalStep } from '../../engine/recovery/wal.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, card, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { decodeWalSteps, encodeWalSteps } from '../../ui/walUrl.ts';

/**
 * plan.md §25.4 E1: a log, a buffer pool and a disk, and the rule that ties them together. You write the script; the
 * page runs it and shows, for every step, what was appended, what was forced, what was written — and with the rule
 * switched off, the page that reached disk with its log still in memory.
 */

const FRAME_CHOICES = [2, 3, 4] as const;
const TXNS = ['T1', 'T2', 'T3'] as const;
const KEYS = Object.values(DEFAULT_PAGES).flatMap((cells) => Object.keys(cells));
const PAGES = Object.keys(DEFAULT_PAGES).map(Number);

interface Preset {
  label: string;
  lookFor: string;
  lines: WalStep[];
  frames: number;
  enforce: boolean;
}

const set = (txn: string, key: string, value: number): WalStep => ({ op: 'set', txn, key, value });

const PRESETS: Preset[] = [
  {
    label: 'Commit forces the log',
    lookFor: 'A commit is durable once its record is. Watch the log get forced, and notice no data page is written.',
    frames: 3,
    enforce: true,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 99), set('T1', 'c', 5), { op: 'commit', txn: 'T1' }],
  },
  {
    label: 'The page needs its log first',
    lookFor: 'A dirty page is written to disk. The log has to go first, but only as far as that page needs.',
    frames: 3,
    enforce: true,
    lines: [
      { op: 'begin', txn: 'T1' },
      set('T1', 'a', 1),
      set('T1', 'c', 2),
      set('T1', 'e', 3),
      { op: 'write-page', page: 2 },
    ],
  },
  {
    label: 'Eviction pays the same price',
    lookFor: 'Nobody asked for a write: the pool needed a frame, and its victim was dirty.',
    frames: 2,
    enforce: true,
    lines: [
      { op: 'begin', txn: 'T1' },
      set('T1', 'a', 1),
      { op: 'read-page', page: 2 },
      { op: 'read-page', page: 3 },
    ],
  },
  {
    label: 'Rollback is logged too',
    lookFor: 'Undoing a change writes a compensation record for each one, newest first, so the undo is never repeated.',
    frames: 3,
    enforce: true,
    lines: [
      { op: 'begin', txn: 'T1' },
      set('T1', 'a', 1),
      set('T1', 'c', 2),
      set('T1', 'a', 3),
      { op: 'abort', txn: 'T1' },
    ],
  },
  {
    label: 'Break the rule',
    lookFor: 'The same write as the second example, with the rule off: the page is on disk and its log record is not.',
    frames: 3,
    enforce: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), set('T1', 'c', 2), { op: 'write-page', page: 1 }],
  },
];

function readInitial(): { steps: WalStep[]; frames: number; enforce: boolean } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const steps = decodeWalSteps(params.get('s'));
  const asked = Number(params.get('f'));
  const frames = FRAME_CHOICES.find((n) => n === asked) ?? 3;
  const enforce = params.get('e') !== '0';
  if (steps === null) {
    const first = PRESETS[0]!;
    return { steps: first.lines, frames: first.frames, enforce: first.enforce };
  }
  return { steps, frames, enforce };
}

const INITIAL = readInitial();

function EffectLine({ effect }: { effect: WalEffect }) {
  switch (effect.kind) {
    case 'log-append':
      return (
        <span>
          <span className="font-mono">LSN {effect.record.lsn}</span> appended to the log buffer: {describeRecord(effect.record)}
        </span>
      );
    case 'log-flush':
      return (
        <span>
          Log forced, {effect.from === effect.to ? `LSN ${String(effect.to)}` : `LSN ${String(effect.from)}–${String(effect.to)}`} now durable
          {effect.reason === 'log-before-data' ? ' — because a page about to be written needs it' : ''}
          {effect.reason === 'commit' ? ' — for the commit' : ''}
        </span>
      );
    case 'page-fetch':
      return (
        <span>
          Page {effect.page} {effect.hit ? 'is in the pool' : 'read from disk'} (frame {effect.slot})
        </span>
      );
    case 'page-evict':
      return (
        <span>
          Page {effect.page} evicted from frame {effect.slot} — {effect.dirty ? 'dirty' : 'clean'}
        </span>
      );
    case 'page-write':
      return (
        <span>
          Page {effect.page} written to disk with pageLSN {effect.pageLSN}
        </span>
      );
    case 'rule-violated':
      return (
        <span className="text-evict">
          Page {effect.page} written ahead of its log: pageLSN {effect.pageLSN}, log durable only through {effect.flushedLSN}
        </span>
      );
  }
}

function LogTable({ records, caption, tone }: { records: LogRecord[]; caption: string; tone: 'durable' | 'buffer' }) {
  if (records.length === 0) return <p className="text-label text-ink-dim">{caption}: empty.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-label tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-ink-dim">
            <th scope="col" className="pr-3 font-medium">LSN</th>
            <th scope="col" className="pr-3 font-medium">prevLSN</th>
            <th scope="col" className="pr-3 font-medium">txn</th>
            <th scope="col" className="font-medium">record</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.lsn} className={tone === 'durable' ? 'text-ink' : 'text-ink-dim'}>
              <td className="pr-3 font-mono">{r.lsn}</td>
              <td className="pr-3 font-mono">{r.prevLSN ?? '—'}</td>
              <td className="pr-3">{r.txn}</td>
              <td>{describeRecord(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatePanels({ state, frames }: { state: WalState; frames: number }) {
  const resident = state.pool.filter((f) => f !== null);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">Buffer pool</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-label tabular-nums">
            <caption className="sr-only">The {frames} frames of the buffer pool</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="pr-3 font-medium">frame</th>
                <th scope="col" className="pr-3 font-medium">page</th>
                <th scope="col" className="pr-3 font-medium">cells</th>
                <th scope="col" className="pr-3 font-medium">pageLSN</th>
                <th scope="col" className="font-medium">recLSN</th>
              </tr>
            </thead>
            <tbody>
              {state.pool.map((f, slot) =>
                f ? (
                  <tr key={slot} className="text-ink">
                    <td className="pr-3 font-mono">{slot}</td>
                    <td className="pr-3 font-mono">{f.page}</td>
                    <td className="pr-3 font-mono">{cellsText(f.cells)}</td>
                    <td className="pr-3 font-mono">{f.pageLSN}</td>
                    <td className={f.recLSN === null ? 'text-ink-dim' : 'font-mono text-evict'}>
                      {f.recLSN === null ? 'clean' : `${f.recLSN} (dirty)`}
                    </td>
                  </tr>
                ) : (
                  <tr key={slot} className="text-ink-dim">
                    <td className="pr-3 font-mono">{slot}</td>
                    <td colSpan={4}>empty</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        {resident.length === 0 && <p className="mt-1 text-label text-ink-dim">Nothing has been read yet.</p>}
      </div>

      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">Disk</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-label tabular-nums">
            <caption className="sr-only">The pages on disk</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="pr-3 font-medium">page</th>
                <th scope="col" className="pr-3 font-medium">cells</th>
                <th scope="col" className="font-medium">pageLSN</th>
              </tr>
            </thead>
            <tbody>
              {state.disk.map((p) => (
                <tr key={p.page} className={p.pageLSN > state.flushedLSN ? 'text-evict' : 'text-ink'}>
                  <td className="pr-3 font-mono">{p.page}</td>
                  <td className="pr-3 font-mono">{cellsText(p.cells)}</td>
                  <td className="font-mono">{p.pageLSN}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">
          Durable log <span className="font-normal text-ink-dim">— through LSN {state.flushedLSN}</span>
        </h3>
        <LogTable records={state.log} caption="The durable log" tone="durable" />
      </div>

      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">
          Log buffer <span className="font-normal text-ink-dim">— lost if the machine stops now</span>
        </h3>
        <LogTable records={state.logBuffer} caption="The log buffer" tone="buffer" />
        {state.txns.length > 0 && (
          <p className="mt-2 text-label text-ink-dim">
            {state.txns
              .map(
                (t) =>
                  `${t.txn} ${t.status === 'active' ? 'active' : t.outcome === 'committed' ? 'committed' : 'rolled back'}${
                    t.lastLSN === null ? '' : `, last LSN ${String(t.lastLSN)}`
                  }`,
              )
              .join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}

export function WalToolPage() {
  const [steps, setSteps] = useState<WalStep[]>(INITIAL.steps);
  const [frames, setFrames] = useState<number>(INITIAL.frames);
  const [enforce, setEnforce] = useState<boolean>(INITIAL.enforce);
  const [selected, setSelected] = useState<number | null>(null);
  const [txn, setTxn] = useState<string>('T1');
  const [key, setKey] = useState<string>('a');
  const [value, setValue] = useState<string>('99');
  const [page, setPage] = useState<number>(1);

  const run = useMemo(() => runWal(steps, { frames, enforce }), [steps, frames, enforce]);
  const preset = PRESETS.find(
    (p) => p.frames === frames && p.enforce === enforce && JSON.stringify(p.lines) === JSON.stringify(steps),
  );
  const at = selected !== null && selected < run.steps.length ? selected : run.steps.length - 1;
  const current = at >= 0 ? run.steps[at]! : null;
  const state = current?.state ?? run.initial;

  useEffect(() => {
    const params = new URLSearchParams();
    if (steps.length > 0) params.set('s', encodeWalSteps(steps));
    if (frames !== 3) params.set('f', String(frames));
    if (!enforce) params.set('e', '0');
    const next = `${location.pathname}${params.size > 0 ? `?${params.toString()}` : ''}`;
    if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
  }, [steps, frames, enforce]);

  const full = steps.length >= MAX_WAL_STEPS;
  const add = (step: WalStep) => {
    if (full) return;
    setSteps((prev) => [...prev, step]);
    setSelected(null);
  };
  const valueNumber = Number(value);
  const valueOk = value.trim() !== '' && Number.isInteger(valueNumber) && Math.abs(valueNumber) < 1_000_000_000;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Write-ahead log">
        A page may not reach disk before the log records that describe its changes are durable (plan.md §25.4 E1).
        Write a script of changes, commits and rollbacks; the page runs it against a buffer pool, a disk and a log, and
        shows for every step what was appended, what was forced and what was written. Switch the rule off to see what
        it was for. Choose a step to see the state after it.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Buffer pool frames
          <div className="flex gap-1" role="radiogroup" aria-label="Buffer pool frames">
            {FRAME_CHOICES.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={frames === n}
                onClick={() => { setFrames(n); }}
                className={`${segBase} ${frames === n ? segOn : segOff}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Log before data
          <div className="flex gap-1" role="radiogroup" aria-label="Log before data">
            {[
              { value: true, label: 'Enforced' },
              { value: false, label: 'Off' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={enforce === o.value}
                onClick={() => { setEnforce(o.value); }}
                className={`${segBase} ${enforce === o.value ? segOn : segOff}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <p className="min-w-56 flex-1 text-label text-ink-dim">
          {enforce
            ? 'Before a dirty page is written — by the writer or by eviction — the log is flushed through its pageLSN.'
            : 'A dirty page is written whenever it is asked to be, whatever the log has made durable. A crash here would find changes on disk that nothing records.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Transaction
          <select className={inputField} value={txn} onChange={(e) => { setTxn(e.target.value); }}>
            {TXNS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Cell
          <select className={inputField} value={key} onChange={(e) => { setKey(e.target.value); }}>
            {KEYS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          New value
          <input
            type="number"
            value={value}
            onChange={(e) => { setValue(e.target.value); }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <button
          type="button"
          disabled={full || !valueOk}
          onClick={() => { add({ op: 'set', txn, key, value: valueNumber }); }}
          className={btnPrimary}
        >
          Add change
        </button>
        <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
        {(['begin', 'commit', 'abort'] as const).map((op) => (
          <button key={op} type="button" disabled={full} onClick={() => { add({ op, txn }); }} className={btnSecondary}>
            {op === 'abort' ? 'Roll back' : op === 'begin' ? 'Begin' : 'Commit'} {txn}
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Page
          <select className={inputField} value={page} onChange={(e) => { setPage(Number(e.target.value)); }}>
            {PAGES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={full} onClick={() => { add({ op: 'write-page', page }); }} className={btnSecondary}>
          Write page
        </button>
        <button type="button" disabled={full} onClick={() => { add({ op: 'read-page', page }); }} className={btnSecondary}>
          Read page
        </button>
        <button type="button" disabled={full} onClick={() => { add({ op: 'flush-log' }); }} className={btnSecondary}>
          Flush log
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
        Examples
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={preset === p}
            onClick={() => {
              setSteps(p.lines);
              setFrames(p.frames);
              setEnforce(p.enforce);
              setSelected(null);
            }}
            className={`${btnSecondary} ${preset === p ? 'border-accent' : ''}`}
          >
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => { setSteps([]); setSelected(null); }} className={btnSecondary}>
          Clear
        </button>
        <span className="ml-auto">
          {steps.length} of {MAX_WAL_STEPS} steps
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className={`${panelSurface} p-4`}>
          <h2 className="mb-2 text-body font-semibold text-ink">The script</h2>
          {preset && <p className="mb-2 text-label text-ink-dim">{preset.lookFor}</p>}
          {run.steps.length === 0 ? (
            <p className="text-label text-ink-dim">Add a step, or load an example.</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {run.steps.map((r, i) => (
                <li key={i} className="flex items-center gap-1">
                  <span className="w-6 text-right text-label tabular-nums text-ink-dim">{i + 1}.</span>
                  <button
                    type="button"
                    aria-pressed={i === at}
                    aria-label={`Step ${String(i + 1)}: ${formatWalStep(r.step)}${r.error ? ', refused' : ''}`}
                    onClick={() => { setSelected(i); }}
                    className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-left font-mono text-label ${
                      i === at ? 'border-accent' : 'border-edge'
                    } ${r.error ? 'text-evict' : r.violations.length > 0 ? 'text-evict' : 'text-ink'}`}
                  >
                    {formatWalStep(r.step)}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSteps((prev) => prev.filter((_, j) => j !== i));
                      setSelected(null);
                    }}
                    className="rounded-md px-1.5 text-label text-ink-dim hover:text-ink"
                    aria-label={`Remove step ${String(i + 1)}`}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ol>
          )}
          {run.truncated && <p className="mt-2 text-label text-evict">Only the first {MAX_WAL_STEPS} steps were run.</p>}
        </div>

        <div className="flex flex-col gap-3">
          <div className={`${panelSurface} p-4`} role="region" aria-label="What the selected step did">
            <h2 className="mb-1 text-body font-semibold text-ink">
              {current ? (
                <>
                  Step {at + 1}: <span className="font-mono">{formatWalStep(current.step)}</span>
                </>
              ) : (
                'The start'
              )}
            </h2>
            {current ? (
              <>
                {current.error && <p className="text-label text-evict">Refused: {current.error}</p>}
                {current.notes.length > 0 && (
                  <ul className="mb-2 flex flex-col gap-1 text-label text-ink">
                    {current.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {current.effects.length > 0 && (
                  <ul className="list-disc pl-5 text-label text-ink-dim">
                    {current.effects.map((e, i) => (
                      <li key={i}>
                        <EffectLine effect={e} />
                      </li>
                    ))}
                  </ul>
                )}
                {current.violations.length > 0 && (
                  <p className="mt-2 rounded-md border border-evict/50 p-2 text-label text-evict" role="alert">
                    {current.violations.join(' ')}
                  </p>
                )}
              </>
            ) : (
              <p className="text-label text-ink-dim">Nothing has run. Four pages on disk, an empty pool and an empty log.</p>
            )}
          </div>
          <StatePanels state={state} frames={frames} />
        </div>
      </div>
    </div>
  );
}
