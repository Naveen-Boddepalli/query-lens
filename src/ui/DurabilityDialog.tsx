import { useEffect, useMemo, useRef, useState } from 'react';
import { applyLogOp, crashImageOf, databaseOfLog, diskDatabase, memoryCells, openEngineLog, walStateOf } from '../engine/recovery/engineLogOps.ts';
import type { LogOp, LogOpResult } from '../engine/recovery/engineLogOps.ts';
import { engineLogKit, inSync } from '../engine/recovery/engineLog.ts';
import type { EngineLog, EngineLogKit } from '../engine/recovery/engineLog.ts';
import { cellText } from '../engine/recovery/wal.ts';
import type { Cell } from '../engine/recovery/wal.ts';
import type { Database, EngineOptions } from '../engine/types.ts';
import { btnGhost, btnPrimary, btnSecondary, inputField, segBase, segOff, segOn } from './primitives.ts';
import { CrashPanel, EffectsList, RecoveryPanels, ScrollBox, StatePanels } from './walPanels.tsx';

/**
 * plan.md §28.5 I2: the Playground's write-ahead log, on the engine's own buffer pool. Off until a visitor turns it on
 * here (plan.md §28.6 rule 10), because a logged write reads its pages again to change them and logs each row, which
 * moves the counters a trace shows. Once on, every `INSERT`, `UPDATE` and `DELETE` the Playground runs is a
 * transaction of its own in this log, left open; this dialog decides what becomes of each — commit, roll back — and can
 * crash the machine and recover it. Whatever the log then holds is what the Playground holds.
 */

/** The log, and what the dialog remembers of it: the last operation, and the database as it stood before a crash. */
export interface Durability {
  log: EngineLog;
  /** What the Playground hands `runQuery` to log a write: loaded with this dialog, so the engine does not carry it. */
  kit: EngineLogKit;
  last: LogOpResult | null;
  beforeCrash: Record<string, Cell> | null;
}

export interface DurabilityDialogProps {
  db: Database;
  options: EngineOptions;
  durability: Durability | null;
  /** The log changed; `database` is set when what it holds changed too, and the Playground should hold that. */
  onChange: (next: Durability | null, database?: Database) => void;
  onClose: () => void;
}

const STATUS = { active: 'open', committed: 'committed', 'rolled-back': 'rolled back' } as const;

export function DurabilityDialog({ db, options, durability, onChange, onClose }: DurabilityDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [steal, setSteal] = useState(true);
  const [force, setForce] = useState(false);
  const [cut, setCut] = useState('1');

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const log = durability?.log ?? null;
  const stale = log !== null && !inSync(log, db);
  const settingsMoved = log !== null && (log.frames !== options.bufferFrames || log.rowsPerPage !== options.rowsPerPage);
  const state = useMemo(() => (log ? walStateOf(log) : null), [log]);
  const crash = useMemo(() => (log && !log.crashed ? crashImageOf(log) : null), [log]);
  const residentPages = log ? Object.keys(log.resident).map(Number).sort((a, b) => a - b) : [];
  const [page, setPage] = useState<number | null>(null);
  const writable = page !== null && residentPages.includes(page) ? page : (residentPages[0] ?? null);

  const start = () => {
    onChange({ log: openEngineLog(db, options, { steal, force }), kit: engineLogKit, last: null, beforeCrash: null });
  };

  const act = (op: LogOp) => {
    if (!durability) return;
    const result = applyLogOp(durability.log, op, options);
    const next: Durability = {
      log: result.log,
      kit: durability.kit,
      last: result,
      beforeCrash: op.op === 'crash' && !result.error ? memoryCells(durability.log) : durability.beforeCrash,
    };
    if (result.error) {
      onChange(next);
      return;
    }
    // A rollback or a recovery changes rows; a crash leaves only what the disk holds.
    if (op.op === 'crash') onChange(next, diskDatabase(result.log));
    else if (op.op === 'abort' || op.op === 'recover') onChange(next, databaseOfLog(result.log));
    else onChange(next);
  };

  const status = (txn: string): string => {
    const t = log?.txns.find((x) => x.txn === txn);
    if (!t) return log?.crashed ? 'lost in the crash' : 'lost';
    return t.status === 'active' ? STATUS.active : t.outcome === 'committed' ? STATUS.committed : STATUS['rolled-back'];
  };

  const comparison = useMemo(() => {
    if (!log || !durability?.beforeCrash) return null;
    const before = durability.beforeCrash;
    const now = memoryCells(log);
    const keys = Object.keys(log.committed).filter((k) => before[k] !== log.committed[k] || now[k] !== log.committed[k]);
    return { before, now, keys };
  }, [log, durability]);

  const cutNumber = Number(cut);
  const cutOk = Number.isInteger(cutNumber) && cutNumber >= 1 && cutNumber <= 20;
  const busy = !log || stale || settingsMoved;
  const last = durability?.last ?? null;

  // A big table has hundreds of pages, nearly all of them as they began: the disk panel shows the ones that are not.
  const shown = state && log ? { ...state, disk: state.disk.filter((p) => p.pageLSN > 0 || log.resident[p.page] !== undefined) } : null;

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
            With the log on, every <code>INSERT</code>, <code>UPDATE</code> and <code>DELETE</code> you run here goes
            through a write-ahead log on the engine&rsquo;s own buffer pool: each row it changes is logged before its page
            changes, and a dirty page goes to disk only after its log records have. Each statement is a transaction of its
            own, left open; here you commit it or roll it back, and then <strong>crash</strong> — the pool, the log buffer
            and every open transaction are gone — and <strong>recover</strong> from the disk and the durable log alone.
          </p>

          {!log && (
            <section aria-label="Turn the log on" className="space-y-3 rounded-xl border border-edge bg-surface-2 p-3">
              <p className="text-label text-ink">
                The log is <strong>off</strong>. A logged write reads each page again to change it and logs every row, so its
                trace has more steps and its counters differ — which is why it is off until you turn it on. It runs on the
                Playground&rsquo;s pool of {options.bufferFrames} frames and pages of {options.rowsPerPage} rows.
              </p>
              <div className="flex flex-wrap items-end gap-3">
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
                <button type="button" onClick={start} className={btnPrimary}>
                  Turn the log on
                </button>
              </div>
            </section>
          )}

          {log && (stale || settingsMoved) && (
            <div className="rounded-md border border-evict/50 p-3 text-label text-evict" role="alert">
              <p>
                {stale
                  ? 'The Playground’s database is not the one this log holds — it was reloaded or edited since — so writes are not logged.'
                  : `The log began on a pool of ${String(log.frames)} frames and pages of ${String(log.rowsPerPage)} rows; the engine now has ${String(options.bufferFrames)} and ${String(options.rowsPerPage)}, so writes are refused.`}
              </p>
              <button type="button" onClick={start} className={`mt-2 ${btnSecondary}`}>
                Start the log again from this database
              </button>
            </div>
          )}

          {log && (
            <section aria-label="The statements" className="space-y-2">
              <h3 className="text-body font-semibold">
                Statements{' '}
                <span className="font-normal text-ink-dim">
                  — {log.steal ? 'steal' : 'no-steal'}, {log.force ? 'force' : 'no-force'}, {log.frames} frames
                </span>
              </h3>
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
                          <tr key={s.txn} className={st.startsWith('lost') ? 'text-evict' : 'text-ink'}>
                            <td className="pr-3 font-mono">{s.txn}</td>
                            <td className="max-w-[20rem] break-words pr-3 font-mono">{s.sql}</td>
                            <td className="pr-3 tabular-nums">{s.rows}</td>
                            <td className="pr-3">{st}</td>
                            <td>
                              {st === 'open' && !log.crashed && (
                                <span className="flex gap-1">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => { act({ op: 'commit', txn: s.txn }); }}
                                    className={btnSecondary}
                                    aria-label={`Commit ${s.txn}`}
                                  >
                                    Commit
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => { act({ op: 'abort', txn: s.txn }); }}
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
          )}

          {log && (
            <section aria-label="Controls" className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3">
              <label className="flex flex-col gap-1 text-label text-ink-dim">
                Page in the pool
                <select
                  className={inputField}
                  value={writable ?? ''}
                  disabled={residentPages.length === 0}
                  onChange={(e) => { setPage(Number(e.target.value)); }}
                >
                  {residentPages.map((p) => (
                    <option key={p} value={p}>
                      {p}
                      {log.resident[p]!.recLSN === null ? ' (clean)' : ' (dirty)'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || log.crashed || writable === null}
                onClick={() => { if (writable !== null) act({ op: 'write-page', page: writable }); }}
                className={btnSecondary}
              >
                Write page
              </button>
              <button type="button" disabled={busy || log.crashed} onClick={() => { act({ op: 'flush-log' }); }} className={btnSecondary}>
                Flush log
              </button>
              <button type="button" disabled={busy || log.crashed} onClick={() => { act({ op: 'checkpoint' }); }} className={btnSecondary}>
                Checkpoint
              </button>
              <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
              <button type="button" disabled={busy || log.crashed} onClick={() => { act({ op: 'crash' }); }} className={btnPrimary}>
                Crash
              </button>
              <button type="button" disabled={busy || !log.crashed} onClick={() => { act({ op: 'recover' }); }} className={btnPrimary}>
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
                  disabled={busy || !log.crashed || !cutOk}
                  onClick={() => { act({ op: 'recover', crashAfter: cutNumber }); }}
                  className={btnSecondary}
                >
                  Recover, then crash
                </button>
              </span>
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={start} className={btnGhost}>
                  Start over
                </button>
                <button type="button" onClick={() => { onChange(null); }} className={btnGhost}>
                  Turn the log off
                </button>
              </span>
            </section>
          )}

          {log?.crashed && (
            <p className="rounded-md border border-evict/50 p-2 text-label text-evict" role="status">
              The machine is down. Nothing runs until it recovers; the disk and the durable log are what it has, and the
              Playground shows what the disk holds.
            </p>
          )}

          {last && (last.notes.length > 0 || last.error) && (
            <section aria-label="What the last action did" className="rounded-lg border border-edge p-3">
              <h3 className="mb-1 text-body font-semibold">
                What the last action did: <span className="font-mono">{last.op.op}</span>
              </h3>
              {last.error && <p className="text-label text-evict">Refused: {last.error}</p>}
              <ul className="flex flex-col gap-1 text-label text-ink">
                {last.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <div className="mt-2">
                <EffectsList effects={last.effects} />
              </div>
            </section>
          )}

          {last?.recovery && <RecoveryPanels report={last.recovery} />}

          {log && comparison && (
            <section aria-label="Before the crash, after recovery, and committed" className="rounded-lg border border-edge p-3">
              <h3 className="mb-1 text-body font-semibold">Before the crash, now, and what committed</h3>
              {comparison.keys.length === 0 ? (
                <p className="text-label text-ink">
                  The database the Playground held was already exactly what committed, and it still is.
                </p>
              ) : (
                <ScrollBox label="The rows that differ">
                  <table className="w-full text-left text-label">
                    <caption className="sr-only">The rows whose value differs between the Playground before the crash, now and the commits</caption>
                    <thead>
                      <tr className="text-ink-dim">
                        <th scope="col" className="pr-3 font-medium">row</th>
                        <th scope="col" className="pr-3 font-medium">before the crash</th>
                        <th scope="col" className="pr-3 font-medium">{log.crashed ? 'on disk now' : 'after recovery'}</th>
                        <th scope="col" className="font-medium">what committed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.keys.map((k) => {
                        const wrong = !log.crashed && comparison.now[k] !== log.committed[k];
                        return (
                          <tr key={k} className="align-top text-ink">
                            <td className="pr-3 font-mono">{k}</td>
                            <td className="pr-3 font-mono">{cellText(comparison.before[k] ?? null)}</td>
                            <td className={`pr-3 font-mono ${wrong ? 'text-evict' : ''}`}>{cellText(comparison.now[k] ?? null)}</td>
                            <td className="font-mono">{cellText(log.committed[k] ?? null)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollBox>
              )}
            </section>
          )}

          {crash && <CrashPanel crash={crash} />}
          {log && shown && (
            <>
              {log.logStart > 1 && (
                <p className="text-label text-ink-dim">
                  The log starts at LSN <span className="font-mono text-ink">{log.logStart}</span>: a checkpoint truncated the
                  records before it, which no restart can need.
                </p>
              )}
              <StatePanels state={shown} frames={log.frames} />
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
