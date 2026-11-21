import { useMemo, useState } from 'react';
import {
  DEFAULT_PAGES,
  MAX_WAL_STEPS,
  comparePolicies,
  formatWalStep,
  runWal,
} from '../../engine/recovery/wal.ts';
import type { WalStep } from '../../engine/recovery/wal.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { CrashPanel, EffectsList, ScrollBox, StatePanels } from '../../ui/walPanels.tsx';
import { decodeWalSteps, encodeWalSteps } from '../../ui/walUrl.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * plan.md §25.4 E1, E2: a log, a buffer pool and a disk, and the rule that ties them together. You write the script; the
 * page runs it and shows, for every step, what was appended, what was forced, what was written — and with the rule
 * switched off, the page that reached disk with its log still in memory. Steal and force are the two policies that
 * decide when a page may be written, and the page shows what each leaves a crash to find.
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
  steal: boolean;
  force: boolean;
}

const set = (txn: string, key: string, value: number): WalStep => ({ op: 'set', txn, key, value });

const PRESETS: Preset[] = [
  {
    label: 'Commit forces the log',
    lookFor: 'A commit is durable once its record is. Watch the log get forced, and notice no data page is written.',
    frames: 3,
    enforce: true,
    steal: true,
    force: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 99), set('T1', 'c', 5), { op: 'commit', txn: 'T1' }],
  },
  {
    label: 'The page needs its log first',
    lookFor: 'A dirty page is written to disk. The log has to go first, but only as far as that page needs.',
    frames: 3,
    enforce: true,
    steal: true,
    force: false,
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
    steal: true,
    force: false,
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
    steal: true,
    force: false,
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
    steal: true,
    force: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), set('T1', 'c', 2), { op: 'write-page', page: 1 }],
  },
  {
    label: 'Steal: uncommitted on disk',
    lookFor: 'The pool needed a frame and took one with T1’s uncommitted change. If the machine stopped now, that change would be on disk and nobody committed it.',
    frames: 2,
    enforce: true,
    steal: true,
    force: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), { op: 'read-page', page: 2 }, { op: 'read-page', page: 3 }],
  },
  {
    label: 'No-steal: nowhere to put it',
    lookFor: 'Nothing uncommitted may be written, so T1’s pages stay in the pool — and with two frames, the third page has nowhere to go.',
    frames: 2,
    enforce: true,
    steal: false,
    force: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), set('T1', 'c', 2), { op: 'read-page', page: 3 }],
  },
  {
    label: 'Force: the commit pays',
    lookFor: 'Every page T1 changed is written inside the commit. Nothing is owed afterwards; the commit did the work.',
    frames: 4,
    enforce: true,
    steal: true,
    force: true,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), set('T1', 'c', 2), set('T1', 'e', 3), { op: 'commit', txn: 'T1' }],
  },
  {
    label: 'No-force: the commit owes pages',
    lookFor: 'The same commit writes only the log. The changes are durable, and three pages on disk are behind them.',
    frames: 4,
    enforce: true,
    steal: true,
    force: false,
    lines: [{ op: 'begin', txn: 'T1' }, set('T1', 'a', 1), set('T1', 'c', 2), set('T1', 'e', 3), { op: 'commit', txn: 'T1' }],
  },
];

function readInitial(): { steps: WalStep[]; frames: number; enforce: boolean; steal: boolean; force: boolean } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const steps = decodeWalSteps(params.get('s'));
  const asked = Number(params.get('f'));
  const frames = FRAME_CHOICES.find((n) => n === asked) ?? 3;
  const enforce = params.get('e') !== '0';
  const steal = params.get('st') !== '0';
  const force = params.get('fo') === '1';
  if (steps === null) {
    const first = PRESETS[0]!;
    return { steps: first.lines, frames: first.frames, enforce: first.enforce, steal: first.steal, force: first.force };
  }
  return { steps, frames, enforce, steal, force };
}

const INITIAL = readInitial();

export function WalToolPage() {
  const [steps, setSteps] = useState<WalStep[]>(INITIAL.steps);
  const [frames, setFrames] = useState<number>(INITIAL.frames);
  const [enforce, setEnforce] = useState<boolean>(INITIAL.enforce);
  const [steal, setSteal] = useState<boolean>(INITIAL.steal);
  const [force, setForce] = useState<boolean>(INITIAL.force);
  const [selected, setSelected] = useState<number | null>(null);
  const [txn, setTxn] = useState<string>('T1');
  const [key, setKey] = useState<string>('a');
  const [value, setValue] = useState<string>('99');
  const [page, setPage] = useState<number>(1);

  const run = useMemo(() => runWal(steps, { frames, enforce, steal, force }), [steps, frames, enforce, steal, force]);
  const policies = useMemo(() => comparePolicies(steps, { frames, enforce }), [steps, frames, enforce]);
  const preset = PRESETS.find(
    (p) =>
      p.frames === frames &&
      p.enforce === enforce &&
      p.steal === steal &&
      p.force === force &&
      JSON.stringify(p.lines) === JSON.stringify(steps),
  );
  const at = selected !== null && selected < run.steps.length ? selected : run.steps.length - 1;
  const current = at >= 0 ? run.steps[at]! : null;
  const state = current?.state ?? run.initial;

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (steps.length > 0) params.set('s', encodeWalSteps(steps));
    if (frames !== 3) params.set('f', String(frames));
    if (!enforce) params.set('e', '0');
    if (!steal) params.set('st', '0');
    if (force) params.set('fo', '1');
    return params.toString();
  }, [steps, frames, enforce, steal, force]);
  useAddressBarQuery(shareQuery, 0);

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
        A page may not reach disk before the log records that describe its changes are durable.
        Write a script of changes, commits and rollbacks; the page runs it against a buffer pool, a disk and a log, and
        shows for every step what was appended, what was forced and what was written. Switch the rule off to see what
        it was for. <strong>Steal</strong> and <strong>force</strong> decide when a page may be written (E2): choose
        a step and the page says what a crash <em>right then</em> would find on disk, and the table at the bottom
        runs the same script under all four combinations.
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
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Uncommitted pages
          <div className="flex gap-1" role="radiogroup" aria-label="Steal policy">
            {[
              { value: true, label: 'Steal' },
              { value: false, label: 'No-steal' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={steal === o.value}
                onClick={() => { setSteal(o.value); }}
                className={`${segBase} ${steal === o.value ? segOn : segOff}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          At commit
          <div className="flex gap-1" role="radiogroup" aria-label="Force policy">
            {[
              { value: false, label: 'No-force' },
              { value: true, label: 'Force' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={force === o.value}
                onClick={() => { setForce(o.value); }}
                className={`${segBase} ${force === o.value ? segOn : segOff}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <p className="min-w-56 flex-1 text-label text-ink-dim">
          {enforce
            ? 'Before a dirty page is written — by the writer or by eviction — the log is flushed through its pageLSN. '
            : 'A dirty page is written whenever it is asked to be, whatever the log has made durable. A crash here would find changes on disk that nothing records. '}
          {steal
            ? 'Steal: the pool may write a page with an uncommitted change, so recovery may have to undo.'
            : 'No-steal: a page with an uncommitted change is pinned until its transaction ends, so there is never anything to undo — and a big transaction needs a big pool.'}{' '}
          {force
            ? 'Force: a commit writes every page it changed, so there is nothing to redo, and every commit pays for random writes.'
            : 'No-force: a commit writes only the log, so the pages are owed and recovery may have to redo.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-wrap items-end gap-3">
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
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {(['begin', 'commit', 'abort'] as const).map((op) => (
            <button key={op} type="button" disabled={full} onClick={() => { add({ op, txn }); }} className={btnSecondary}>
              {op === 'abort' ? 'Roll back' : op === 'begin' ? 'Begin' : 'Commit'} {txn}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
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
              setSteal(p.steal);
              setForce(p.force);
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
                <EffectsList effects={current.effects} />
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
          <CrashPanel crash={current?.crash ?? { undo: [], redo: [], lostRecords: 0 }} />
          <StatePanels state={state} frames={frames} />
        </div>
      </div>

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-1 text-body font-semibold text-ink">The same script, four ways</h2>
        <p className="mb-2 text-label text-ink-dim">
          Run under each steal and force combination. <em>Worst moment</em> is the most cells a crash at any single step
          would have left to undo or redo; <em>at the end</em> is a crash after the last step.
        </p>
        <ScrollBox label="The four policies compared">
          <table className="w-full min-w-[40rem] text-left text-label tabular-nums">
            <caption className="sr-only">The script under steal and no-steal, force and no-force</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="py-1 pr-3 font-medium">Policy</th>
                <th scope="col" className="px-2 py-1 font-medium">Pages written in commits</th>
                <th scope="col" className="px-2 py-1 font-medium">Other page writes</th>
                <th scope="col" className="px-2 py-1 font-medium">Steps refused</th>
                <th scope="col" className="px-2 py-1 font-medium">Undo, worst moment</th>
                <th scope="col" className="px-2 py-1 font-medium">Redo, worst moment</th>
                <th scope="col" className="px-2 py-1 font-medium">At the end</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((o) => {
                const isCurrent = o.steal === steal && o.force === force;
                return (
                  <tr key={`${String(o.steal)}-${String(o.force)}`} className={isCurrent ? 'bg-surface-2' : ''}>
                    <th scope="row" className="py-1 pr-3 font-normal">
                      <button
                        type="button"
                        aria-pressed={isCurrent}
                        onClick={() => { setSteal(o.steal); setForce(o.force); }}
                        className={`rounded-md border px-2 py-1 text-left text-ink ${isCurrent ? 'border-accent' : 'border-edge'}`}
                      >
                        {o.steal ? 'Steal' : 'No-steal'}, {o.force ? 'force' : 'no-force'}
                      </button>
                    </th>
                    <td className="px-2 py-1 text-ink">{o.commitWrites}</td>
                    <td className="px-2 py-1 text-ink">{o.otherWrites}</td>
                    <td className={`px-2 py-1 ${o.refused > 0 ? 'text-evict' : 'text-ink'}`}>{o.refused}</td>
                    <td className={`px-2 py-1 ${o.worstUndo > 0 ? 'text-evict' : 'text-ink'}`}>{o.worstUndo}</td>
                    <td className={`px-2 py-1 ${o.worstRedo > 0 ? 'text-evict' : 'text-ink'}`}>{o.worstRedo}</td>
                    <td className="px-2 py-1 text-ink">
                      {o.endUndo} to undo, {o.endRedo} to redo
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollBox>
      </div>
    </div>
  );
}
