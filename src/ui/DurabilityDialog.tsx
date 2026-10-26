import { useEffect, useMemo, useRef, useState } from 'react';
import { databaseFromCells, heapFromCells, tableOfPage } from '../engine/recovery/heap.ts';
import { cellText, committedCells, databaseCells, runWal } from '../engine/recovery/wal.ts';
import type { WalStep } from '../engine/recovery/wal.ts';
import type { Database } from '../engine/types.ts';
import type { DurableHeap } from '../engine/recovery/heap.ts';
import { LOG_MAX_STEPS, inSync } from './durableLog.ts';
import type { DurableLog } from './durableLog.ts';
import { btnGhost, btnPrimary, btnSecondary, inputField, segBase, segOff, segOn } from './primitives.ts';
import { CrashPanel, EffectsList, RecoveryPanels, ScrollBox, StatePanels } from './walPanels.tsx';

/**
 * plan.md §25.4 E4: the statements run in the Playground, as a write-ahead log would have kept them — and the choice of
 * what becomes of each. Commit one, leave another open, write a page, then crash: the pool and the log buffer are
 * gone, and a recovery from the disk and the durable log gives back exactly what committed. The Playground's own
 * tables can then be replaced with it.
 */

export interface DurabilityDialogProps {
  db: Database;
  log: DurableLog;
  onAppend: (step: WalStep) => void;
  onRestart: () => void;
  onUse: (recovered: Database, heap: DurableHeap) => void;
  onClose: () => void;
}

const FRAME_CHOICES = [2, 4, 6] as const;

export function DurabilityDialog({ db, log, onAppend, onRestart, onUse, onClose }: DurabilityDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [frames, setFrames] = useState<number>(4);
  const [steal, setSteal] = useState(true);
  const [force, setForce] = useState(false);
  const [page, setPage] = useState<number>(1);
  const [cut, setCut] = useState('1');

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const run = useMemo(
    () => runWal(log.steps, { pages: log.pages, frames, steal, force, maxSteps: LOG_MAX_STEPS }),
    [log.steps, log.pages, frames, steal, force],
  );
  const final = run.final;
  const stale = !inSync(log, db);
  const pageIds = useMemo(() => Object.keys(log.pages).map(Number), [log.pages]);

  const lastControl = [...run.steps].reverse().find((r) => r.step.op !== 'begin' && r.step.op !== 'set');
  const lastRecovery = [...run.steps].reverse().find((r) => r.recovery !== undefined);
  const crashIndex = run.steps.map((r) => r.step.op).lastIndexOf('crash');
  const recovered = !final.crashed && lastRecovery !== undefined;

  const status = (txn: string): 'open' | 'committed' | 'rolled back' | 'lost' => {
    const t = final.txns.find((x) => x.txn === txn);
    if (!t) return 'lost';
    if (t.status === 'active') return 'open';
    return t.outcome === 'committed' ? 'committed' : 'rolled back';
  };

  const comparison = useMemo(() => {
    if (crashIndex < 0) return null;
    const before = crashIndex > 0 ? run.steps[crashIndex - 1]!.state : run.initial;
    const beforeCells = databaseCells(before);
    const afterCells = databaseCells(final);
    const want = committedCells(final, log.pages);
    const keys = Object.keys(want).filter(
      (k) => beforeCells[k] !== want[k] || (recovered && afterCells[k] !== want[k]),
    );
    return { beforeCells, afterCells, want, keys };
  }, [run, crashIndex, final, log.pages, recovered]);

  const full = log.steps.length >= LOG_MAX_STEPS;
  const cutNumber = Number(cut);
  const cutOk = Number.isInteger(cutNumber) && cutNumber >= 1 && cutNumber <= 20;

  const useRecovered = () => {
    const cells = databaseCells(final);
    onUse(databaseFromCells(log.base, log.heap, cells), heapFromCells(log.heap, cells));
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialog}
      aria-label="Durability"
      onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) onClose(); }}
      className="max-h-[90dvh] w-[min(64rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-edge bg-surface p-0 text-ink shadow-e3 backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[90dvh] flex-col">
        <header className="flex items-center gap-3 border-b border-edge bg-surface-2/40 px-4 py-3">
          <h2 className="text-heading font-semibold">Durability</h2>
          <button type="button" onClick={onClose} className={`ml-auto ${btnGhost}`}>
            Close
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto p-4">
          <p className="text-label text-ink-dim">
            Every <code>INSERT</code>, <code>UPDATE</code> and <code>DELETE</code> you run in the Playground is kept here as
            a transaction of its own, written to a log as a database would write it. The Playground shows each one&rsquo;s
            effect at once; here you decide what becomes of it — commit it, leave it open — and then <strong>crash</strong>:
            the pool, the log buffer and every open transaction are gone, and <strong>recover</strong> rebuilds the
            database from the disk and the durable log alone.
          </p>

          {stale && (
            <div className="rounded-md border border-evict/50 p-3 text-label text-evict" role="alert">
              <p>
                The Playground&rsquo;s database is not the one this log began with — it was reloaded or edited since. The
                log below describes the old one.
              </p>
              <button type="button" onClick={onRestart} className={`mt-2 ${btnSecondary}`}>
                Start the log again from this database
              </button>
            </div>
          )}
          {log.refused && (
            <p className="rounded-md border border-evict/50 p-2 text-label text-evict" role="alert">
              The newest statement is not in the log: {log.refused}
            </p>
          )}

          <section aria-label="The statements" className="space-y-2">
            <h3 className="text-body font-semibold">Statements</h3>
            {log.statements.length === 0 ? (
              <p className="text-label text-ink-dim">
                Nothing yet. Close this, run an <code>UPDATE</code> in the Playground, and open this again.
              </p>
            ) : (
              <ScrollBox label="The statements run in the Playground">
                <table className="w-full text-left text-label">
                  <caption className="sr-only">The write statements run in the Playground and what became of each</caption>
                  <thead>
                    <tr className="text-ink-dim">
                      <th scope="col" className="pr-3 font-medium">txn</th>
                      <th scope="col" className="pr-3 font-medium">statement</th>
                      <th scope="col" className="pr-3 font-medium">rows</th>
                      <th scope="col" className="pr-3 font-medium">now</th>
                      <th scope="col" className="font-medium">decide</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.statements.map((s) => {
                      const st = status(s.txn);
                      return (
                        <tr key={s.txn} className={st === 'lost' ? 'text-evict' : 'text-ink'}>
                          <td className="pr-3 font-mono">{s.txn}</td>
                          <td className="max-w-[20rem] break-words pr-3 font-mono">{s.sql}</td>
                          <td className="pr-3 tabular-nums">{s.rows}</td>
                          <td className="pr-3">{st === 'lost' ? 'lost in the crash' : st}</td>
                          <td>
                            {st === 'open' && !final.crashed && (
                              <span className="flex gap-1">
                                <button
                                  type="button"
                                  disabled={full || stale}
                                  onClick={() => { onAppend({ op: 'commit', txn: s.txn }); }}
                                  className={btnSecondary}
                                  aria-label={`Commit ${s.txn}`}
                                >
                                  Commit
                                </button>
                                <button
                                  type="button"
                                  disabled={full || stale}
                                  onClick={() => { onAppend({ op: 'abort', txn: s.txn }); }}
                                  className={btnSecondary}
                                  aria-label={`Roll back ${s.txn}`}
                                >
                                  Roll back
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollBox>
            )}
          </section>

          <section aria-label="Controls" className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3">
            <div className="flex flex-col gap-1 text-label text-ink-dim">
              Pool frames
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
            <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Page
              <select className={inputField} value={page} onChange={(e) => { setPage(Number(e.target.value)); }}>
                {pageIds.map((p) => (
                  <option key={p} value={p}>
                    {p} ({tableOfPage(log.heap, p) ?? '—'})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={full || stale || final.crashed}
              onClick={() => { onAppend({ op: 'write-page', page }); }}
              className={btnSecondary}
            >
              Write page
            </button>
            <button
              type="button"
              disabled={full || stale || final.crashed}
              onClick={() => { onAppend({ op: 'flush-log' }); }}
              className={btnSecondary}
            >
              Flush log
            </button>
            <button
              type="button"
              disabled={full || stale || final.crashed}
              onClick={() => { onAppend({ op: 'checkpoint' }); }}
              className={btnSecondary}
            >
              Checkpoint
            </button>
            <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
            <button
              type="button"
              disabled={full || stale || final.crashed}
              onClick={() => { onAppend({ op: 'crash' }); }}
              className={btnPrimary}
            >
              Crash
            </button>
            <button
              type="button"
              disabled={full || stale || !final.crashed}
              onClick={() => { onAppend({ op: 'recover' }); }}
              className={btnPrimary}
            >
              Recover
            </button>
            <span className="flex items-end gap-1 text-label text-ink-dim">
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
                disabled={full || stale || !final.crashed || !cutOk}
                onClick={() => { onAppend({ op: 'recover', crashAfter: cutNumber }); }}
                className={btnSecondary}
              >
                Recover, then crash
              </button>
            </span>
            <button type="button" onClick={onRestart} className={`ml-auto ${btnGhost}`}>
              Start over
            </button>
          </section>

          {final.crashed && (
            <p className="rounded-md border border-evict/50 p-2 text-label text-evict" role="status">
              The machine is down. Nothing runs until it recovers; the disk and the durable log are what it has.
            </p>
          )}

          {lastControl && (lastControl.notes.length > 0 || lastControl.error) && (
            <section aria-label="What the last action did" className="rounded-lg border border-edge p-3">
              <h3 className="mb-1 text-body font-semibold">
                What the last action did: <span className="font-mono">{lastControl.step.op}</span>
              </h3>
              {lastControl.error && <p className="text-label text-evict">Refused: {lastControl.error}</p>}
              <ul className="flex flex-col gap-1 text-label text-ink">
                {lastControl.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <div className="mt-2">
                <EffectsList effects={lastControl.effects} />
              </div>
            </section>
          )}

          {lastRecovery?.recovery && <RecoveryPanels report={lastRecovery.recovery} />}

          {comparison && (
            <section aria-label="Before the crash, after recovery, and committed" className="rounded-lg border border-edge p-3">
              <h3 className="mb-1 text-body font-semibold">Before the crash, after recovery, and what committed</h3>
              {comparison.keys.length === 0 ? (
                <p className="text-label text-ink">
                  {recovered
                    ? 'The database the Playground held was already exactly what committed, and recovery kept it so.'
                    : 'The crash would lose nothing: the disk and the log already agree with what committed.'}
                </p>
              ) : (
                <ScrollBox label="The rows that differ">
                  <table className="w-full text-left text-label">
                    <caption className="sr-only">The rows whose value differs between the Playground, recovery and the commits</caption>
                    <thead>
                      <tr className="text-ink-dim">
                        <th scope="col" className="pr-3 font-medium">row</th>
                        <th scope="col" className="pr-3 font-medium">the Playground, before the crash</th>
                        <th scope="col" className="pr-3 font-medium">after recovery</th>
                        <th scope="col" className="font-medium">what committed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.keys.map((k) => {
                        const wrong = recovered && comparison.afterCells[k] !== comparison.want[k];
                        return (
                          <tr key={k} className="align-top text-ink">
                            <td className="pr-3 font-mono">{k}</td>
                            <td className="pr-3 font-mono">{cellText(comparison.beforeCells[k] ?? null)}</td>
                            <td className={`pr-3 font-mono ${wrong ? 'text-evict' : ''}`}>
                              {recovered ? cellText(comparison.afterCells[k] ?? null) : '—'}
                            </td>
                            <td className="font-mono">{cellText(comparison.want[k] ?? null)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollBox>
              )}
              {recovered && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={useRecovered} className={btnPrimary}>
                    Use the recovered database in the Playground
                  </button>
                  <span className="text-label text-ink-dim">
                    Replaces the Playground&rsquo;s tables with what recovery rebuilt, uncommitted statements gone.
                  </span>
                </div>
              )}
            </section>
          )}

          {!final.crashed && <CrashPanel crash={run.steps.at(-1)?.crash ?? { undo: [], redo: [], lostRecords: 0 }} />}
          <StatePanels state={final} frames={frames} />
        </div>
      </div>
    </dialog>
  );
}
