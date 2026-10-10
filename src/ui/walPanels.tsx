import type { ReactNode } from 'react';
import { cellsText, describeRecord } from '../engine/recovery/wal.ts';
import type { CrashImage, LogRecord, RecoveryReport, WalEffect, WalState } from '../engine/recovery/wal.ts';
import { card } from './primitives.ts';

/** The panels the write-ahead-log and recovery pages share: the effects of a step, the log, the pool and the disk. */

/**
 * A table that may be wider than its panel. A scrollable region has to be reachable from the keyboard, and a table of
 * plain text has nothing focusable in it, so the region itself takes the focus.
 */
export function ScrollBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function EffectLine({ effect }: { effect: WalEffect }) {
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
          {effect.reason === 'checkpoint' ? ' — for the checkpoint' : ''}
          {effect.reason === 'recovery' ? ' — recovery forces each record as it writes it' : ''}
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
          {effect.reason === 'force' ? ' — forced by the commit' : effect.reason === 'eviction' ? ' — to make room' : ''}
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

export function LogTable({ records, caption, tone }: { records: LogRecord[]; caption: string; tone: 'durable' | 'buffer' }) {
  if (records.length === 0) return <p className="text-label text-ink-dim">{caption}: empty.</p>;
  return (
    <ScrollBox label="The log records">
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
              <td className="pr-3">{'txn' in r ? r.txn : '—'}</td>
              <td>{describeRecord(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollBox>
  );
}

export function CrashPanel({ crash }: { crash: CrashImage }) {
  const none = crash.undo.length === 0 && crash.redo.length === 0;
  return (
    <div className={card} role="region" aria-label="If the machine stopped here">
      <h3 className="mb-1 text-body font-semibold text-ink">If the machine stopped here</h3>
      <p className="mb-2 text-label text-ink-dim">
        What a crash would find: the disk and the durable log. Recovery would have to make every cell the newest value a
        committed transaction left.
      </p>
      {none && crash.lostRecords === 0 && <p className="text-label text-ink">Nothing to recover: the disk holds exactly the committed state.</p>}
      {crash.undo.length > 0 && (
        <div className="mb-2">
          <p className="text-label text-ink">
            <strong>{crash.undo.length}</strong> {crash.undo.length === 1 ? 'cell holds' : 'cells hold'} a value nobody
            committed — recovery must <strong>undo</strong> {crash.undo.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className="list-disc pl-5 text-label text-ink-dim">
            {crash.undo.map((c) => (
              <li key={`${String(c.page)}-${c.key}`}>
                <span className="font-mono text-ink">
                  {c.key} = {c.onDisk}
                </span>{' '}
                on page {c.page}, written by {c.by}, should be {c.committed}
                {c.logged ? '' : ' — and the log record that says how to undo it is not durable'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {crash.redo.length > 0 && (
        <div className="mb-2">
          <p className="text-label text-ink">
            <strong>{crash.redo.length}</strong> committed {crash.redo.length === 1 ? 'change has' : 'changes have'} not
            reached the disk — recovery must <strong>redo</strong> {crash.redo.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className="list-disc pl-5 text-label text-ink-dim">
            {crash.redo.map((c) => (
              <li key={`${String(c.page)}-${c.key}`}>
                <span className="font-mono text-ink">
                  {c.key} = {c.onDisk}
                </span>{' '}
                on page {c.page}, should be {c.committed} (committed by {c.by})
              </li>
            ))}
          </ul>
        </div>
      )}
      {crash.lostRecords > 0 && (
        <p className="text-label text-ink-dim">
          {crash.lostRecords} log {crash.lostRecords === 1 ? 'record is' : 'records are'} still in the log buffer and
          would be lost.
        </p>
      )}
    </div>
  );
}

export function StatePanels({ state, frames }: { state: WalState; frames: number }) {
  const resident = state.pool.filter((f) => f !== null);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">Buffer pool</h3>
        <ScrollBox label="The buffer pool frames">
          <table className="w-full text-left text-label tabular-nums">
            <caption className="sr-only">The {frames} frames of the buffer pool</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="pr-3 font-medium">frame</th>
                <th scope="col" className="pr-3 font-medium">page</th>
                <th scope="col" className="pr-3 font-medium">cells</th>
                <th scope="col" className="pr-3 font-medium">pageLSN</th>
                <th scope="col" className="pr-3 font-medium">recLSN</th>
                <th scope="col" className="font-medium">uncommitted</th>
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
                    <td className={`pr-3 ${f.recLSN === null ? 'text-ink-dim' : 'font-mono text-evict'}`}>
                      {f.recLSN === null ? 'clean' : `${f.recLSN} (dirty)`}
                    </td>
                    <td className={f.holders.length === 0 ? 'text-ink-dim' : 'text-ink'}>
                      {f.holders.length === 0 ? '—' : f.holders.join(', ')}
                    </td>
                  </tr>
                ) : (
                  <tr key={slot} className="text-ink-dim">
                    <td className="pr-3 font-mono">{slot}</td>
                    <td colSpan={5}>empty</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </ScrollBox>
        {resident.length === 0 && <p className="mt-1 text-label text-ink-dim">Nothing has been read yet.</p>}
      </div>

      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">Disk</h3>
        <ScrollBox label="The pages on disk">
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
        </ScrollBox>
      </div>

      <div className={card}>
        <h3 className="mb-2 text-body font-semibold text-ink">
          Durable log <span className="font-normal text-ink-dim">— through LSN {state.flushedLSN}</span>
        </h3>
        {state.masterLSN !== null && (
          <p className="mb-2 text-label text-ink-dim">
            Master record (on disk): the last checkpoint began at LSN <span className="font-mono text-ink">{state.masterLSN}</span>.
          </p>
        )}
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

/** The three passes of a restart, one panel each: what analysis rebuilt, what redo did and skipped, what undo wrote. */
export function RecoveryPanels({ report }: { report: RecoveryReport }) {
  const a = report.analysis;
  const redone = report.redo.filter((r) => r.action === 'redo').length;
  const undone = report.undo.filter((r) => r.action === 'undo').length;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3" role="region" aria-label="The three passes of recovery">
      <div className={card}>
        <h3 className="mb-1 text-body font-semibold text-ink">1. Analysis</h3>
        <p className="mb-2 text-label text-ink-dim">
          {a.checkpoint === null
            ? 'No checkpoint: the scan starts at the beginning of the log.'
            : `Scan from the checkpoint that began at LSN ${String(a.checkpoint)}, with the tables it saved.`}
        </p>
        <p className="text-label font-medium text-ink">Dirty page table</p>
        {a.dirtyPages.length === 0 ? (
          <p className="mb-2 text-label text-ink-dim">Empty.</p>
        ) : (
          <ScrollBox label="The dirty page table">
            <table className="mb-2 w-full text-left text-label tabular-nums">
              <caption className="sr-only">The dirty page table analysis built</caption>
              <thead>
                <tr className="text-ink-dim">
                  <th scope="col" className="pr-3 font-medium">page</th>
                  <th scope="col" className="font-medium">recLSN</th>
                </tr>
              </thead>
              <tbody>
                {a.dirtyPages.map((d) => (
                  <tr key={d.page} className="text-ink">
                    <td className="pr-3 font-mono">{d.page}</td>
                    <td className="font-mono">{d.recLSN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>
        )}
        <p className="text-label font-medium text-ink">Transaction table</p>
        {a.txns.length === 0 ? (
          <p className="mb-2 text-label text-ink-dim">Empty: every transaction had ended.</p>
        ) : (
          <ScrollBox label="The transaction table">
            <table className="mb-2 w-full text-left text-label tabular-nums">
              <caption className="sr-only">The transaction table analysis built</caption>
              <thead>
                <tr className="text-ink-dim">
                  <th scope="col" className="pr-3 font-medium">txn</th>
                  <th scope="col" className="pr-3 font-medium">status</th>
                  <th scope="col" className="font-medium">lastLSN</th>
                </tr>
              </thead>
              <tbody>
                {a.txns.map((t) => (
                  <tr key={t.txn} className={t.status === 'committed' ? 'text-ink' : 'text-evict'}>
                    <td className="pr-3">{t.txn}</td>
                    <td className="pr-3">{t.status === 'committed' ? 'committed' : t.status === 'aborting' ? 'rolling back' : 'running'}</td>
                    <td className="font-mono">{t.lastLSN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>
        )}
        <p className="text-label text-ink">
          {a.losers.length === 0 ? 'No losers.' : `Losers: ${a.losers.join(', ')}.`}{' '}
          {a.redoFrom === null ? 'Nothing to redo.' : `Redo starts at LSN ${String(a.redoFrom)}.`}
        </p>
      </div>

      <div className={card}>
        <h3 className="mb-1 text-body font-semibold text-ink">2. Redo</h3>
        <p className="mb-2 text-label text-ink-dim">
          Repeat history: every change from the oldest recLSN, whoever made it, unless the page already has it.{' '}
          <strong>{redone}</strong> redone, <strong>{report.redo.length - redone}</strong> skipped.
        </p>
        {report.redo.length === 0 ? (
          <p className="text-label text-ink-dim">Nothing examined.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-label">
            {report.redo.map((r) => (
              <li key={r.lsn} className={r.action === 'redo' ? 'text-ink' : 'text-ink-dim'}>
                <span className="font-mono">LSN {r.lsn}</span> ({r.key}, page {r.page}) —{' '}
                <strong>{r.action === 'redo' ? 'redo' : 'skip'}</strong>: {r.reason}
              </li>
            ))}
          </ul>
        )}
        {report.ended.length > 0 && (
          <p className="mt-2 text-label text-ink-dim">
            End record written for {report.ended.join(', ')}: committed, with nothing left to do.
          </p>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-1 text-body font-semibold text-ink">3. Undo</h3>
        <p className="mb-2 text-label text-ink-dim">
          Roll the losers back, newest record first, logging a compensation record for each: <strong>{undone}</strong>{' '}
          undone{report.interrupted ? ' — and then the machine stopped again' : ''}.
        </p>
        {report.undo.length === 0 ? (
          <p className="text-label text-ink-dim">Nothing to undo.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-label">
            {report.undo.map((u, i) => (
              <li key={i} className={u.action === 'undo' ? 'text-ink' : 'text-ink-dim'}>
                <span className="font-mono">LSN {u.lsn}</span> ({u.txn}) — <strong>{u.action}</strong>: {u.detail}
                {u.clr !== null && (
                  <>
                    {' '}
                    — logged as <span className="font-mono">LSN {u.clr}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
