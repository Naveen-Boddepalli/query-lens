import { useMemo, useState } from 'react';
import {
  DEFAULT_PAGES,
  MAX_WAL_STEPS,
  committedCells,
  databaseCells,
  formatWalStep,
  runWal,
} from '../../engine/recovery/wal.ts';
import type { WalStep } from '../../engine/recovery/wal.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { CrashPanel, EffectsList, RecoveryPanels, StatePanels } from '../../ui/walPanels.tsx';
import { decodeWalSteps, encodeWalSteps } from '../../ui/walUrl.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * plan.md §25.4 E3: checkpoints, a crash button, and ARIES — analysis, redo, undo — with the dirty page table, the
 * transaction table and the compensation records on the page. The same machine as the write-ahead-log page; what is
 * new is that the machine can stop, and be started again from the disk and the log alone.
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
const begin = (txn: string): WalStep => ({ op: 'begin', txn });
const commit = (txn: string): WalStep => ({ op: 'commit', txn });
const write = (page: number): WalStep => ({ op: 'write-page', page });

const PRESETS: Preset[] = [
  {
    label: 'Redo: committed, never written',
    lookFor:
      'T1 committed, and its pages never left the pool. After the crash the disk is behind the log, and redo catches it up.',
    frames: 3,
    enforce: true,
    lines: [begin('T1'), set('T1', 'a', 99), set('T1', 'c', 5), commit('T1'), { op: 'crash' }, { op: 'recover' }],
  },
  {
    label: 'Undo: written, never committed',
    lookFor:
      'T1’s page was written out and T1 never committed. Redo puts the change back; undo takes it out again, logging a compensation record.',
    frames: 3,
    enforce: true,
    lines: [begin('T1'), set('T1', 'a', 99), write(1), { op: 'flush-log' }, { op: 'crash' }, { op: 'recover' }],
  },
  {
    label: 'Both at once',
    lookFor:
      'T1 committed and T2 did not, and both touched pages that did and did not reach disk. Analysis sorts winners from losers.',
    frames: 3,
    enforce: true,
    lines: [
      begin('T1'),
      begin('T2'),
      set('T1', 'a', 1),
      set('T2', 'c', 2),
      set('T2', 'd', 3),
      commit('T1'),
      write(2),
      { op: 'crash' },
      { op: 'recover' },
    ],
  },
  {
    label: 'A checkpoint shortens the work',
    lookFor:
      'Everything before the checkpoint had been written, so analysis starts there and redo never looks back. Compare the passes with the same script without it.',
    frames: 3,
    enforce: true,
    lines: [
      begin('T1'),
      set('T1', 'a', 1),
      set('T1', 'c', 2),
      commit('T1'),
      write(1),
      write(2),
      { op: 'checkpoint' },
      begin('T2'),
      set('T2', 'e', 9),
      { op: 'flush-log' },
      { op: 'crash' },
      { op: 'recover' },
    ],
  },
  {
    label: 'Crash during recovery',
    lookFor:
      'Recovery stops after two undo records. The second restart finds those compensation records, follows them, and undoes only what is left.',
    frames: 4,
    enforce: true,
    lines: [
      begin('T1'),
      set('T1', 'a', 1),
      set('T1', 'c', 2),
      set('T1', 'e', 3),
      write(1),
      write(2),
      write(3),
      { op: 'crash' },
      { op: 'recover', crashAfter: 2 },
      { op: 'recover' },
    ],
  },
  {
    label: 'Break the rule',
    lookFor:
      'The page went to disk ahead of its log. After the crash nothing says what the change was, so recovery cannot undo it — and the page says so.',
    frames: 3,
    enforce: false,
    lines: [begin('T1'), set('T1', 'a', 99), write(1), { op: 'crash' }, { op: 'recover' }],
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
    return { steps: first.lines, frames: first.frames, enforce: first.enforce, steal: true, force: false };
  }
  return { steps, frames, enforce, steal, force };
}

const INITIAL = readInitial();

export function RecoveryToolPage() {
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
  const [cut, setCut] = useState<string>('2');

  const run = useMemo(() => runWal(steps, { frames, enforce, steal, force }), [steps, frames, enforce, steal, force]);
  const preset = PRESETS.find(
    (p) =>
      p.frames === frames &&
      p.enforce === enforce &&
      steal &&
      !force &&
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
  const cutNumber = Number(cut);
  const cutOk = Number.isInteger(cutNumber) && cutNumber >= 1 && cutNumber <= 20;

  // Is the database right? Only a question once the machine is up and nothing is mid-flight: a running transaction's
  // changes are rightly not the committed state yet.
  const verdict = useMemo(() => {
    if (state.crashed || state.txns.some((t) => t.status === 'active')) return null;
    const have = databaseCells(state);
    const want = committedCells(state, DEFAULT_PAGES);
    const wrong = Object.keys(want).filter((k) => have[k] !== want[k]);
    const unlogged = state.disk.some((p) => p.pageLSN > state.flushedLSN);
    return { wrong, have, want, unlogged };
  }, [state]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Crash recovery">
        The write-ahead log, stopped and restarted. Run a script, press <strong>Crash</strong> — the
        pool, the log buffer and every transaction are gone; the disk, the durable log and the master record stay — and{' '}
        <strong>Recover</strong>. ARIES restarts from the last checkpoint in three passes: <em>analysis</em> rebuilds the
        dirty page table and the transaction table and names the losers, <em>redo</em> repeats history, <em>undo</em>{' '}
        rolls the losers back, logging each undo so that a crash during recovery never undoes a change twice. Choose a step
        to see the state after it.
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
          ARIES assumes steal and no-force, which is why it needs both an undo and a redo pass. Switch the rule off and a page
          can reach disk ahead of the record that would undo it.
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
        <div className="flex flex-wrap items-end gap-3">
          <button type="button" disabled={full} onClick={() => { add({ op: 'checkpoint' }); }} className={btnSecondary}>
            Checkpoint
          </button>
          <button type="button" disabled={full} onClick={() => { add({ op: 'checkpoint-begin' }); }} className={btnSecondary}>
            Begin checkpoint
          </button>
          <button type="button" disabled={full} onClick={() => { add({ op: 'checkpoint-end' }); }} className={btnSecondary}>
            End checkpoint
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <button type="button" disabled={full} onClick={() => { add({ op: 'crash' }); }} className={btnPrimary}>
            Crash
          </button>
          <button type="button" disabled={full} onClick={() => { add({ op: 'recover' }); }} className={btnPrimary}>
            Recover
          </button>
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            …stopping again after
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={20}
                value={cut}
                onChange={(e) => { setCut(e.target.value); }}
                className={`${inputField} w-16 tabular-nums`}
                aria-label="Undo records to write before the machine stops again"
              />
              <button
                type="button"
                disabled={full || !cutOk}
                onClick={() => { add({ op: 'recover', crashAfter: cutNumber }); }}
                className={btnSecondary}
              >
                Recover, then crash
              </button>
            </span>
          </label>
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
              setSteal(true);
              setForce(false);
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
                    } ${r.error || r.step.op === 'crash' ? 'text-evict' : 'text-ink'}`}
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

          {state.crashed && (
            <p className="rounded-md border border-evict/50 p-2 text-label text-evict" role="status">
              The machine is down. The pool is empty, the log buffer is gone, and no transaction exists; the disk and the
              durable log are what recovery has to work from.
            </p>
          )}

          {current?.recovery && <RecoveryPanels report={current.recovery} />}

          {verdict && (
            <div className="rounded-lg border border-edge p-3" role="region" aria-label="Is the database right?">
              <h3 className="mb-1 text-body font-semibold text-ink">Is the database right?</h3>
              {verdict.wrong.length === 0 ? (
                <p className="text-label text-ink">
                  Yes: the pool over the disk holds exactly what the committed transactions left.
                </p>
              ) : (
                <div className="text-label text-evict">
                  <p>
                    No: {verdict.wrong.length} {verdict.wrong.length === 1 ? 'cell differs' : 'cells differ'} from what the
                    committed transactions left —{' '}
                    {verdict.wrong.map((k) => `${k} is ${String(verdict.have[k])}, not ${String(verdict.want[k])}`).join('; ')}.
                  </p>
                  {verdict.unlogged && (
                    <p className="mt-1">
                      A page on disk is ahead of the durable log. The record that would say how to undo it was never made
                      durable, so a restart has nothing to undo it with.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {!state.crashed && <CrashPanel crash={current?.crash ?? { undo: [], redo: [], lostRecords: 0 }} />}
          <StatePanels state={state} frames={frames} />
        </div>
      </div>
    </div>
  );
}
