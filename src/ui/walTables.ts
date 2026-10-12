/**
 * The write-ahead-log and recovery panels as rows (plan.md §H6, a data-table view for every panel): the same facts the
 * panels show as sentences and cards, one fact to a row, in the order they happened, so that a screen reader can walk
 * them cell by cell and a sighted reader can scan a column. Pure functions of the machine's own results.
 */

import { describeRecord } from '../engine/recovery/wal.ts';
import type { RecoveryReport, WalEffect } from '../engine/recovery/wal.ts';

export interface EffectRow {
  n: number;
  what: string;
  page: string;
  lsn: string;
  detail: string;
}

const lsnRange = (from: number, to: number): string => (from === to ? String(to) : `${String(from)}–${String(to)}`);

export function effectRows(effects: readonly WalEffect[]): EffectRow[] {
  return effects.map((e, i): EffectRow => {
    const n = i + 1;
    switch (e.kind) {
      case 'log-append':
        return {
          n,
          what: 'log record appended',
          page: 'page' in e.record ? String(e.record.page) : '—',
          lsn: String(e.record.lsn),
          detail: `${'txn' in e.record ? `${e.record.txn}: ` : ''}${describeRecord(e.record)}`,
        };
      case 'log-flush':
        return {
          n,
          what: 'log forced',
          page: '—',
          lsn: lsnRange(e.from, e.to),
          detail:
            e.reason === 'log-before-data'
              ? 'because a page about to be written needs it'
              : e.reason === 'commit'
                ? 'for the commit'
                : e.reason === 'checkpoint'
                  ? 'for the checkpoint'
                  : e.reason === 'recovery'
                    ? 'recovery forces each record as it writes it'
                    : 'asked for',
        };
      case 'page-fetch':
        return {
          n,
          what: e.hit ? 'page found in the pool' : 'page read from disk',
          page: String(e.page),
          lsn: '—',
          detail: `frame ${String(e.slot)}`,
        };
      case 'page-evict':
        return {
          n,
          what: 'page evicted',
          page: String(e.page),
          lsn: '—',
          detail: `from frame ${String(e.slot)}, ${e.dirty ? 'dirty' : 'clean'}`,
        };
      case 'page-write':
        return {
          n,
          what: 'page written to disk',
          page: String(e.page),
          lsn: String(e.pageLSN),
          detail:
            e.reason === 'force' ? 'forced by the commit' : e.reason === 'eviction' ? 'to make room' : 'by the writer',
        };
      case 'rule-violated':
        return {
          n,
          what: 'written ahead of its log',
          page: String(e.page),
          lsn: String(e.pageLSN),
          detail: `the log is durable only through ${String(e.flushedLSN)}`,
        };
    }
  });
}

export interface RecoveryRow {
  n: number;
  pass: 'Analysis' | 'Redo' | 'Undo';
  lsn: string;
  subject: string;
  action: string;
  why: string;
}

/** The three passes of one restart, one row per thing each pass found or did. */
export function recoveryRows(report: RecoveryReport): RecoveryRow[] {
  const rows: Omit<RecoveryRow, 'n'>[] = [];
  const a = report.analysis;
  rows.push({
    pass: 'Analysis',
    lsn: String(a.from),
    subject: a.checkpoint === null ? 'the log' : 'the last checkpoint',
    action: 'scan starts here',
    why:
      a.checkpoint === null
        ? 'there is no checkpoint, so the scan starts at the beginning'
        : `the master record points at the checkpoint that began at LSN ${String(a.checkpoint)}`,
  });
  for (const d of a.dirtyPages) {
    rows.push({
      pass: 'Analysis',
      lsn: String(d.recLSN),
      subject: `page ${String(d.page)}`,
      action: 'in the dirty page table',
      why: `first dirtied at LSN ${String(d.recLSN)}, so redo may need to look from there`,
    });
  }
  for (const t of a.txns) {
    rows.push({
      pass: 'Analysis',
      lsn: String(t.lastLSN),
      subject: t.txn,
      action: t.status === 'committed' ? 'winner' : 'loser',
      why:
        t.status === 'committed'
          ? 'has a commit record, but no end record yet'
          : t.status === 'aborting'
            ? 'was rolling back when the machine stopped'
            : 'has changes and no commit record',
    });
  }
  for (const r of report.redo) {
    rows.push({
      pass: 'Redo',
      lsn: String(r.lsn),
      subject: `${r.key}, page ${String(r.page)}`,
      action: r.action === 'redo' ? 'redone' : 'skipped',
      why: r.reason,
    });
  }
  for (const name of report.ended) {
    rows.push({
      pass: 'Redo',
      lsn: '—',
      subject: name,
      action: 'end record written',
      why: 'committed, with nothing left to do',
    });
  }
  for (const u of report.undo) {
    rows.push({
      pass: 'Undo',
      lsn: String(u.lsn),
      subject: u.txn,
      action: u.action === 'undo' ? 'undone' : u.action === 'end' ? 'finished' : 'followed',
      why: `${u.detail}${u.clr === null ? '' : ` — logged as LSN ${String(u.clr)}`}`,
    });
  }
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}
