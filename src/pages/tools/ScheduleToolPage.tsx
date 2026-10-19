import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createAccountsDatabase, DEFAULT_ENGINE_OPTIONS, runBufferTrace } from '../../engine/index.ts';
import type { Database, Row } from '../../engine/index.ts';
import { explainVisibility } from '../../engine/mvcc.ts';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../../engine/schedule.ts';
import type { LockingOptions, ScheduleStep, ScheduleStepResult, VersionRow } from '../../engine/schedule.ts';
import { ISOLATION_LEVELS } from '../../engine/isolation.ts';
import type { IsolationLevel } from '../../engine/transactionControl.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { DataView } from '../../ui/DataView.tsx';
import { decodeSchedule, encodeSchedule, MAX_STATEMENT_LENGTH, SESSIONS } from '../../ui/scheduleUrl.ts';
import { SCHEDULE_COLUMNS, scheduleRows } from '../../ui/transactionTables.ts';
import type { SessionName } from '../../ui/scheduleUrl.ts';
import {
  btnPrimary,
  btnSecondary,
  card,
  inputField,
  panelSurface,
  pill,
  segBase,
  segOff,
  segOn,
} from '../../ui/primitives.ts';
import { modeName } from '../../engine/locks/lockTable.ts';
import { PrecedencePanel } from '../../ui/PrecedencePanel.tsx';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * plan.md §25.4 D1, D2: two sessions, one database, and an interleaving you choose. With *no locking* a statement
 * sees and changes whatever the database holds, uncommitted changes included, and `ROLLBACK` really undoes — the page
 * names what that lets through (a dirty read, a dirty write). With *page* or *row* locking the same schedule runs under
 * strict two-phase locking: a statement that cannot get its lock waits, and a deadlock rolls back the youngest.
 */

type LockingMode = 'none' | 'page' | 'row' | 'mvcc';
const DEFAULT_ISOLATION: IsolationLevel = 'repeatable-read';
const LOCKING_MODES: { value: LockingMode; label: string }[] = [
  { value: 'none', label: 'No locking' },
  { value: 'page', label: 'Page locks' },
  { value: 'row', label: 'Row locks' },
  { value: 'mvcc', label: 'Versions (MVCC)' },
];
const TABLE_SIZES = [3, 20] as const;
type TableSize = (typeof TABLE_SIZES)[number];

/** Lock escalation (plan.md §27.5 T2): off, or the leaf locks on one table a transaction may hold before it escalates. */
const ESCALATIONS = [0, 2, 5] as const;
type Escalation = (typeof ESCALATIONS)[number];

const ISOLATION_BUTTONS: Record<IsolationLevel, string> = {
  'read-uncommitted': 'Read uncommitted',
  'read-committed': 'Read committed',
  'repeatable-read': 'Repeatable read',
  serializable: 'Serializable',
};

interface Preset {
  label: string;
  steps: ScheduleStep[];
  locking: LockingMode;
  rows: TableSize;
  isolation?: IsolationLevel;
  escalation?: Escalation;
}

const PRESETS: Preset[] = [
  {
    label: 'Dirty read',
    locking: 'none',
    rows: 3,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'A', sql: 'ROLLBACK' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 1' },
    ],
  },
  {
    label: 'Dirty write',
    locking: 'none',
    rows: 3,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { session: 'A', sql: 'ROLLBACK' },
    ],
  },
  {
    label: 'Blocked reader',
    locking: 'page',
    rows: 3,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'A', sql: 'ROLLBACK' },
    ],
  },
  {
    label: 'Page vs row',
    locking: 'page',
    rows: 20,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 2' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Non-repeatable read',
    locking: 'row',
    rows: 20,
    isolation: 'read-committed',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Lost update',
    locking: 'row',
    rows: 20,
    isolation: 'read-committed',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 150 WHERE id = 1' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 120 WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Phantom',
    locking: 'row',
    rows: 20,
    isolation: 'repeatable-read',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE balance > 50' },
      { session: 'B', sql: "INSERT INTO accounts VALUES (30, 'zed', 100)" },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE balance > 50' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Snapshot read',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'First committer wins',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 150 WHERE id = 1' },
      { session: 'B', sql: 'COMMIT' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 120 WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Write skew',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE id <= 2' },
      { session: 'B', sql: 'SELECT * FROM accounts WHERE id <= 2' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 0 WHERE id = 2' },
      { session: 'A', sql: 'COMMIT' },
      { session: 'B', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Dead tuples',
    locking: 'mvcc',
    rows: 20,
    isolation: 'read-committed',
    steps: [
      { session: 'A', sql: 'UPDATE accounts SET balance = 1 WHERE id = 1' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 2 WHERE id = 1' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 3 WHERE id = 1' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 0 WHERE id = 2' },
      { session: 'B', sql: 'ROLLBACK' },
    ],
  },
  {
    // plan.md §27.5 T2: three row locks become one table lock, and a reader of a row nobody touched has to wait.
    label: 'Escalation',
    locking: 'row',
    rows: 20,
    escalation: 2,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 1 WHERE id = 1' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 1 WHERE id = 2' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 1 WHERE id = 3' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 10' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Deadlock',
    locking: 'row',
    rows: 20,
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 1 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 2 WHERE id = 2' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 3 WHERE id = 2' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 4 WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
      { session: 'B', sql: 'COMMIT' },
    ],
  },
];

const CONTROL: { label: string; sql: string }[] = [
  { label: 'BEGIN', sql: 'BEGIN' },
  { label: 'COMMIT', sql: 'COMMIT' },
  { label: 'ROLLBACK', sql: 'ROLLBACK' },
];

function readInitial(): { steps: ScheduleStep[]; locking: LockingMode; rows: TableSize; isolation: IsolationLevel; escalation: Escalation } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const steps = decodeSchedule(params.get('s'));
  const lockingRaw = params.get('l');
  const rowsRaw = Number(params.get('n'));
  const isolationRaw = params.get('i');
  const escalation: Escalation = ESCALATIONS.find((e) => e > 0 && String(e) === params.get('e')) ?? 0;
  const locking: LockingMode =
    lockingRaw === 'page' || lockingRaw === 'row' || lockingRaw === 'mvcc' ? lockingRaw : 'none';
  const rows: TableSize = rowsRaw === 20 ? 20 : 3;
  const isolation: IsolationLevel =
    ISOLATION_LEVELS.find((level) => level === isolationRaw) ?? DEFAULT_ISOLATION;
  if (steps === null) {
    const first = PRESETS[0]!;
    return {
      steps: first.steps,
      locking: first.locking,
      rows: first.rows,
      isolation: first.isolation ?? DEFAULT_ISOLATION,
      escalation: first.escalation ?? 0,
    };
  }
  return { steps, locking, rows, isolation, escalation };
}

const INITIAL = readInitial();

const PHASE_LABEL: Record<ScheduleStepResult['phase'], string | null> = {
  ran: null,
  queued: 'waiting behind its session',
  blocked: 'blocked on a lock',
  resumed: 'resumed',
  victim: 'rolled back',
};

function RowsTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: Row[] }) {
  if (rows.length === 0) return <p className="text-label text-ink-dim">{caption}: no rows.</p>;
  return (
    <ScrollRegion label={caption} className="overflow-x-auto">
      <table className="w-full text-left text-label tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-ink-dim">
            {columns.map((c) => (
              <th key={c} scope="col" className="pr-4 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="text-ink">
              {columns.map((c) => (
                <td key={c} className="pr-4 font-mono">{String(row[c] ?? 'NULL')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function versionState(v: VersionRow): string {
  if (v.creator === 'aborted') return 'aborted — dead';
  if (v.creator === 'in-progress') return 'uncommitted';
  return v.live ? 'live' : 'replaced';
}

/** Every version of a row that has a history, with the transaction ids that made and removed it. */
function VersionTable({ versions, columns, caption }: { versions: VersionRow[]; columns: string[]; caption: string }) {
  const changed = new Set(versions.filter((v) => v.xmin !== 0 || v.xmax !== null).map((v) => v.rid));
  const shown = versions.filter((v) => changed.has(v.rid));
  if (shown.length === 0) return <p className="text-label text-ink-dim">{caption}: every row is still its original version.</p>;
  return (
    <ScrollRegion label={caption} className="overflow-x-auto">
      <table className="w-full text-left text-label tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-ink-dim">
            {columns.map((c) => (
              <th key={c} scope="col" className="pr-3 font-medium">{c}</th>
            ))}
            <th scope="col" className="pr-3 font-medium">xmin</th>
            <th scope="col" className="pr-3 font-medium">xmax</th>
            <th scope="col" className="font-medium">state</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((v, i) => (
            <tr key={i} className={v.live && v.creator === 'committed' ? 'text-ink' : 'text-ink-dim'}>
              {columns.map((c) => (
                <td key={c} className="pr-3 font-mono">{String(v.row[c] ?? 'NULL')}</td>
              ))}
              <td className="pr-3 font-mono">{v.xmin}</td>
              <td className="pr-3 font-mono">{v.xmax ?? '—'}</td>
              <td>{versionState(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/**
 * Predict, then reveal (plan.md §25.4 D4): would a statement a session ran now see this version? The answer is the
 * visibility rule applied to that session's snapshot, and the reveal says which half of the rule decided it.
 */
function VisibilityQuiz({
  versions,
  snapshots,
  columns,
}: {
  versions: VersionRow[];
  snapshots: { session: string; xid: number | null; committed: number[] }[];
  columns: string[];
}) {
  const candidates = versions.filter((v) => v.xmin !== 0 || v.xmax !== null);
  const [pick, setPick] = useState(0);
  const [asked, setAsked] = useState<string>(snapshots[0]?.session ?? 'A');
  const [answer, setAnswer] = useState<boolean | null>(null);
  const version = candidates[Math.min(pick, candidates.length - 1)];
  const snapshot = snapshots.find((x) => x.session === asked) ?? snapshots[0];
  if (!version || !snapshot) return null;

  const label = (v: VersionRow) =>
    `${columns.map((c) => `${c} ${String(v.row[c] ?? 'NULL')}`).join(', ')} · xmin ${String(v.xmin)} · xmax ${v.xmax === null ? '—' : String(v.xmax)}`;
  const explained = explainVisibility(
    { rid: version.rid, table: version.table, row: version.row, xmin: version.xmin, xmax: version.xmax, order: 0 },
    new Set(snapshot.committed),
    snapshot.xid ?? -1,
  );

  return (
    <section className="mt-4 rounded-lg border border-edge p-3" aria-label="Visibility question">
      <h3 className="mb-2 text-body font-semibold text-ink">Can they see it?</h3>
      <div className="flex flex-wrap items-end gap-3 text-label text-ink-dim">
        <label className="flex flex-col gap-1">
          Version
          <select
            className={inputField}
            value={pick}
            onChange={(e) => { setPick(Number(e.target.value)); setAnswer(null); }}
          >
            {candidates.map((v, i) => (
              <option key={i} value={i}>{label(v)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Session
          <select
            className={inputField}
            value={asked}
            onChange={(e) => { setAsked(e.target.value); setAnswer(null); }}
          >
            {snapshots.map((x) => (
              <option key={x.session} value={x.session}>{x.session}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-label text-ink">
        If session {snapshot.session} ran a statement now, would it see this version?
      </p>
      <div className="mt-1 flex gap-2">
        <button type="button" className={btnSecondary} onClick={() => { setAnswer(true); }}>Yes, it sees it</button>
        <button type="button" className={btnSecondary} onClick={() => { setAnswer(false); }}>No, it does not</button>
      </div>
      {answer !== null && (
        <div className="mt-2 text-label" role="status">
          <p className={answer === explained.visible ? 'text-hit' : 'text-evict'}>
            {answer === explained.visible ? 'Right.' : 'Not quite.'} Session {snapshot.session}{' '}
            {explained.visible ? 'sees' : 'does not see'} this version.
          </p>
          <p className="mt-1 text-ink-dim">
            {snapshot.session}&rsquo;s snapshot counts {snapshot.committed.map((x) => String(x)).join(', ')} as committed
            {snapshot.xid === null ? '' : `, and it is transaction ${String(snapshot.xid)} itself`}.
          </p>
          <ul className="mt-1 list-disc pl-5 text-ink-dim">
            <li>{explained.created}</li>
            <li>{explained.removed}</li>
          </ul>
        </div>
      )}
    </section>
  );
}

/** What dead versions cost, run through the real buffer pool: three scans of the heap, as it is and after a VACUUM. */
function BloatPanel({ pages, pagesAfterVacuum }: { pages: number; pagesAfterVacuum: number }) {
  const [frames, setFrames] = useState(5);
  const reads = (heapPages: number): number => {
    const once = Array.from({ length: heapPages }, (_, i) => i);
    const trace = runBufferTrace([...once, ...once, ...once], {
      ...DEFAULT_ENGINE_OPTIONS,
      bufferFrames: frames,
      policy: 'lru',
    });
    return trace.events.filter((e) => e.stage === 'buffer' && e.action === 'miss').length;
  };
  if (pages === 0) return null;
  const now = reads(pages);
  const after = reads(pagesAfterVacuum);
  return (
    <section className="mt-4 rounded-lg border border-edge p-3" aria-label="What the dead versions cost">
      <h3 className="mb-2 text-body font-semibold text-ink">What the dead versions cost</h3>
      <label className="flex w-fit flex-col gap-1 text-label text-ink-dim">
        Buffer pool frames
        <input
          type="number"
          min={2}
          max={8}
          value={frames}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 2 && n <= 8) setFrames(n);
          }}
          className={`${inputField} w-20 tabular-nums`}
        />
      </label>
      <p className="mt-2 text-label text-ink" role="status">
        Three full scans of the heap through {String(frames)} LRU frames read {String(now)} pages from disk as it is
        ({String(pages)} pages), and {String(after)} after a VACUUM ({String(pagesAfterVacuum)} pages).
      </p>
      <p className="mt-1 text-label text-ink-dim">
        Run through the real buffer pool, one reference per page of the scan; the versions are laid out four to a page.
        A heap that has grown past the pool is read from disk on every pass.
      </p>
    </section>
  );
}

function resultColumns(rows: Row[]): string[] {
  return rows.length === 0 ? [] : Object.keys(rows[0]!);
}

function StepCard({
  step,
  database,
  onRemove,
}: {
  step: ScheduleStepResult;
  database: Database;
  onRemove: () => void;
}) {
  const label = step.kind === 'statement' ? 'statement' : step.kind.toUpperCase();
  const columns = database.tables.accounts?.columns ?? [];
  const phase = PHASE_LABEL[step.phase];
  const troubled = step.anomalies.length > 0 || step.phase === 'victim';
  const waiting = step.phase === 'blocked' || step.phase === 'queued';
  return (
    <div className={`${card} ${troubled ? 'border-evict/60' : ''} ${waiting ? 'border-dashed' : ''}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
          <span className={pill}>{step.session}</span>
          {step.kind !== 'statement' && <span className="font-mono">{label}</span>}
          {phase && (
            <span className={`rounded-full border px-2 py-0.5 ${troubled ? 'border-evict/50 text-evict' : 'border-edge text-ink'}`}>
              {phase}
            </span>
          )}
        </span>
        {step.phase !== 'resumed' && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md px-1.5 text-label text-ink-dim hover:text-ink"
            aria-label={`Remove step ${String(step.index + 1)}`}
          >
            remove
          </button>
        )}
      </div>
      <code className="block break-words font-mono text-label text-ink">{step.sql}</code>

      {step.waitingOn && step.waitingOn.length > 0 && (
        <p className="mt-2 text-label text-ink">Waiting for {step.waitingOn.join(' and ')} to let go.</p>
      )}
      {step.error && <p className="mt-2 text-label text-evict">{step.error}</p>}

      {step.kind === 'statement' && !step.error && step.run && !step.run.write && step.rows.length > 0 && (
        <div className="mt-2">
          <RowsTable
            caption={`Rows step ${String(step.index + 1)} returned`}
            columns={resultColumns(step.rows)}
            rows={step.rows}
          />
        </div>
      )}

      <ul className="mt-2 space-y-0.5 text-label text-ink-dim">
        {step.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      {step.anomalies.map((a) => (
        <p key={a.message} className="mt-2 rounded-md border border-evict/50 p-2 text-label text-evict" role="note">
          {a.message}
        </p>
      ))}

      {step.locks.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-label text-ink-dim">
            Locks after this step ({step.locks.length})
          </summary>
          <ul className="mt-1 space-y-0.5 text-label text-ink-dim">
            {step.locks.map((l) => (
              <li key={l.resource}>
                <span className="text-ink">{l.resource}</span>
                {l.holders.length > 0 && <> — held by {l.holders.map((h) => `${h.session} (${modeName(h.mode)})`).join(', ')}</>}
                {l.waiters.length > 0 && (
                  <span className="text-evict"> — {l.waiters.map((w) => `${w.session} waits (${modeName(w.mode)})`).join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {step.versions.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-label text-ink-dim">Row versions after this step</summary>
          <div className="mt-1">
            <VersionTable
              versions={step.versions}
              columns={columns}
              caption={`Versions after step ${String(step.index + 1)}, ${step.phase}`}
            />
          </div>
        </details>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-label text-ink-dim">The table after this step</summary>
        <div className="mt-1">
          <RowsTable
            caption={`accounts after step ${String(step.index + 1)}, ${step.phase}`}
            columns={columns}
            rows={step.after.tables.accounts?.rows ?? []}
          />
        </div>
      </details>
    </div>
  );
}

export function ScheduleToolPage() {
  const [steps, setSteps] = useState<ScheduleStep[]>(INITIAL.steps);
  const [locking, setLocking] = useState<LockingMode>(INITIAL.locking);
  const [rows, setRows] = useState<TableSize>(INITIAL.rows);
  const [isolation, setIsolation] = useState<IsolationLevel>(INITIAL.isolation);
  const [escalation, setEscalation] = useState<Escalation>(INITIAL.escalation);
  const [session, setSession] = useState<SessionName>('A');
  const [sql, setSql] = useState('');

  const database = useMemo(() => createAccountsDatabase(rows), [rows]);
  const lockingOptions = useMemo<LockingOptions | undefined>(
    () =>
      locking === 'none'
        ? undefined
        : {
            granularity: locking === 'page' ? 'page' : 'row',
            isolation,
            ...(locking === 'mvcc' ? { mvcc: true } : {}),
            ...(escalation > 0 ? { escalateAt: escalation } : {}),
          },
    [locking, isolation, escalation],
  );
  const result = useMemo(
    () => runSchedule(steps, database, undefined, lockingOptions),
    [steps, database, lockingOptions],
  );
  const columns = database.tables.accounts?.columns ?? [];

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (steps.length > 0) params.set('s', encodeSchedule(steps));
    if (locking !== 'none') params.set('l', locking);
    if (rows !== 3) params.set('n', String(rows));
    if (locking !== 'none' && isolation !== DEFAULT_ISOLATION) params.set('i', isolation);
    if (locking !== 'none' && escalation > 0) params.set('e', String(escalation));
    return params.toString();
  }, [steps, locking, rows, isolation, escalation]);
  useAddressBarQuery(shareQuery);

  function add(statement: string) {
    const trimmed = statement.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_STATEMENT_LENGTH) return;
    if (steps.length >= MAX_SCHEDULE_STEPS) return;
    setSteps((prev) => [...prev, { session, sql: trimmed }]);
  }

  function submit() {
    add(sql);
    setSql('');
  }

  const full = steps.length >= MAX_SCHEDULE_STEPS;
  const compareParams = new URLSearchParams();
  if (steps.length > 0) compareParams.set('s', encodeSchedule(steps));
  compareParams.set('n', String(rows));
  const compareLink = `/tools/concurrency?${compareParams.toString()}`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Transaction schedules">
        Two sessions, one database, and an interleaving you choose (plan.md §25.4 D1, D2). With{' '}
        <strong>no locking</strong>, a statement sees and changes whatever the table holds, another session&rsquo;s
        uncommitted work included, and <code>ROLLBACK</code> really undoes — the page names what that lets through. Turn
        on <strong>page or row locks</strong> and the same schedule runs under strict two-phase locking, enforced by the
        engine: a statement that cannot get its lock waits, and a deadlock rolls back the youngest. The{' '}
        <Link to="/tools/locks" className="underline underline-offset-2 hover:text-ink">
          locks sandbox
        </Link>{' '}
        shows the lock table on its own, and the{' '}
        <Link to={compareLink} className="underline underline-offset-2 hover:text-ink">
          concurrency-control compare
        </Link>{' '}
        runs this schedule under every protocol at once.
      </PageHeader>

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-2 text-body font-semibold text-ink">The table</h2>
        <RowsTable caption="accounts at the start" columns={columns} rows={database.tables.accounts?.rows ?? []} />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Session
          <div className="flex gap-1" role="radiogroup" aria-label="Session">
            {SESSIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={session === s}
                onClick={() => { setSession(s); }}
                className={`${segBase} ${session === s ? segOn : segOff}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <label htmlFor="statement" className="flex min-w-64 flex-1 flex-col gap-1 text-label text-ink-dim">
          Statement
          <input
            id="statement"
            type="text"
            value={sql}
            maxLength={MAX_STATEMENT_LENGTH}
            spellCheck={false}
            placeholder="UPDATE accounts SET balance = 0 WHERE id = 1"
            onChange={(e) => { setSql(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className={`${inputField} font-mono`}
          />
        </label>

        <button type="button" onClick={submit} disabled={full} className={btnPrimary}>
          Add step
        </button>

        <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
        {CONTROL.map((c) => (
          <button key={c.label} type="button" disabled={full} onClick={() => { add(c.sql); }} className={btnSecondary}>
            {c.label}
          </button>
        ))}
        {locking === 'mvcc' && (
          <button type="button" disabled={full} onClick={() => { add('VACUUM'); }} className={btnSecondary}>
            VACUUM
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Locking
          <div className="flex gap-1" role="radiogroup" aria-label="Locking">
            {LOCKING_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={locking === m.value}
                onClick={() => { setLocking(m.value); }}
                className={`${segBase} ${locking === m.value ? segOn : segOff}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {locking !== 'none' && (
          <div className="flex flex-col gap-1 text-label text-ink-dim">
            Isolation
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Isolation level">
              {ISOLATION_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={isolation === level}
                  onClick={() => { setIsolation(level); }}
                  className={`${segBase} ${isolation === level ? segOn : segOff}`}
                >
                  {ISOLATION_BUTTONS[level]}
                </button>
              ))}
            </div>
          </div>
        )}
        {locking !== 'none' && (
          <div className="flex flex-col gap-1 text-label text-ink-dim">
            Escalation
            <div className="flex gap-1" role="radiogroup" aria-label="Lock escalation">
              {ESCALATIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={escalation === e}
                  onClick={() => { setEscalation(e); }}
                  className={`${segBase} ${escalation === e ? segOn : segOff}`}
                >
                  {e === 0 ? 'Off' : `After ${String(e)} locks`}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Accounts
          <div className="flex gap-1" role="radiogroup" aria-label="Number of accounts">
            {TABLE_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rows === n}
                onClick={() => { setRows(n); }}
                className={`${segBase} ${rows === n ? segOn : segOff}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <p className="min-w-56 flex-1 text-label text-ink-dim">
          {locking === 'none'
            ? 'Nothing stops a session reading or overwriting another’s uncommitted change.'
            : locking === 'mvcc'
              ? `A row is a chain of versions, and a reader takes no lock: it sees the versions its snapshot can see. Writers still lock the rows they change. ${
                  isolation === 'repeatable-read'
                    ? 'Repeatable read takes one snapshot per transaction: reads repeat and phantoms cannot appear, a write over a row changed since the snapshot fails (first committer wins), but write skew gets through.'
                    : isolation === 'serializable'
                      ? 'Serializable also checks, at commit, that nothing the transaction read has changed since its snapshot, which stops write skew.'
                      : 'Read committed takes a fresh snapshot per statement, so a repeated read can change.'
                }`
            : `${
                locking === 'page'
                  ? 'A lock per page: every row on a touched page is covered, so unrelated rows collide.'
                  : rows === 3
                    ? 'A lock per row. Three accounts fit one page and the planner scans them, so a scan examines every row and a row lock covers all three.'
                    : 'A lock per row. With twenty accounts an id lookup goes through the index and touches one row, so its neighbours are free.'
              } ${
                isolation === 'read-uncommitted'
                  ? 'Read uncommitted takes no read locks, so it reads changes that are not committed.'
                  : isolation === 'read-committed'
                    ? 'Read committed gives each read lock back as the statement ends, so a repeated read can change.'
                    : isolation === 'repeatable-read'
                      ? 'Repeatable read holds read locks to the end, but locks only rows that exist: a new matching row can still appear.'
                      : 'Serializable also holds each read’s WHERE as a lock, so an insert that would match it waits.'
              }`}
          {/* plan.md §27.5 T2: the hierarchy above every lock, and what escalation trades. */}
          {locking !== 'none' &&
            ` Above each ${locking === 'page' ? 'page' : 'row'} lock it takes an intention lock — IS to read, IX to write — on the table${
              locking === 'page' ? '' : ' and the page'
            }, so a lock on the whole table could see it (the locks sandbox computes which modes can share).${
              escalation > 0
                ? ` Past ${String(escalation)} ${locking === 'page' ? 'page' : 'row'} locks on the table, a transaction escalates: one S or X on the table instead, its finer locks let go — and every other transaction's intention on the table waits.`
                : ''
            }`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
        Examples
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setSteps(p.steps);
              setLocking(p.locking);
              setRows(p.rows);
              setIsolation(p.isolation ?? DEFAULT_ISOLATION);
              setEscalation(p.escalation ?? 0);
            }}
            className={btnSecondary}
          >
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => { setSteps([]); }} className={btnSecondary}>
          Clear
        </button>
        <span className="ml-auto">
          {steps.length} of {MAX_SCHEDULE_STEPS} steps
        </span>
      </div>

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-3 text-body font-semibold text-ink">The schedule</h2>
        {result.steps.length === 0 ? (
          <p className="text-label text-ink-dim">Add a step, or load an example.</p>
        ) : (
          <DataView
            caption="The schedule as it ran, one row for each thing that happened"
            columns={SCHEDULE_COLUMNS}
            rows={scheduleRows(result.steps)}
            keyOf={(r, i) => `${String(i)}-${String(r.n)}`}
          >
            <ol className="flex flex-col gap-3">
              {result.steps.map((step, at) => (
                <li
                  key={`${String(at)}-${String(step.index)}-${step.phase}`}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[2rem_1fr_1fr] sm:items-start"
                >
                  <span className="text-label tabular-nums text-ink-dim">{step.index + 1}.</span>
                  {SESSIONS.map((lane) =>
                    lane === step.session ? (
                      <StepCard
                        key={lane}
                        step={step}
                        database={database}
                        onRemove={() => {
                          setSteps((prev) => prev.filter((_, i) => i !== step.index));
                        }}
                      />
                    ) : (
                      <div key={lane} className="hidden sm:block" aria-hidden />
                    ),
                  )}
                </li>
              ))}
            </ol>
          </DataView>
        )}
        {result.truncated && (
          <p className="mt-2 text-label text-evict">Only the first {MAX_SCHEDULE_STEPS} steps were run.</p>
        )}
        {locking !== 'none' && result.deadlocks > 0 && (
          <p className="mt-2 text-label text-evict">
            {result.deadlocks} deadlock{result.deadlocks === 1 ? '' : 's'} broken by rolling back the youngest transaction.
          </p>
        )}
        {result.stuck.length > 0 && (
          <p className="mt-2 text-label text-evict" role="status">
            {result.stuck.join(' and ')} {result.stuck.length === 1 ? 'is' : 'are'} still waiting for a lock at the end of
            the schedule: whoever holds it never lets go, so the wait never ends.
          </p>
        )}
      </div>

      {/* plan.md §27.5 T1: the same run as a precedence graph, beside the replay check. */}
      {result.steps.length > 0 && <PrecedencePanel result={result} start={database} />}

      {result.bloat !== null && (
        <div className={card}>
          <h2 className="mb-2 text-body font-semibold text-ink">Row versions</h2>
          <VersionTable
            versions={result.steps.at(-1)?.versions ?? []}
            columns={columns}
            caption="Row versions at the end"
          />
          <p className="mt-2 text-label text-ink-dim" role="status">
            {result.bloat.dead === 0
              ? `No dead versions: the heap needs ${String(result.bloat.pages)} pages.`
              : `${String(result.bloat.dead)} dead version${result.bloat.dead === 1 ? '' : 's'} no snapshot can see again: the heap needs ${String(result.bloat.pages)} pages, ${String(result.bloat.pagesAfterVacuum)} after a VACUUM. A scan reads them all.`}
          </p>
          <BloatPanel pages={result.bloat.pages} pagesAfterVacuum={result.bloat.pagesAfterVacuum} />
          <VisibilityQuiz
            versions={result.steps.at(-1)?.versions ?? []}
            snapshots={result.snapshots}
            columns={columns}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={card}>
          <h2 className="mb-2 text-body font-semibold text-ink">At the end</h2>
          <RowsTable
            caption="accounts at the end"
            columns={columns}
            rows={result.final.tables.accounts?.rows ?? []}
          />
        </div>
        <div className={card}>
          <h2 className="mb-2 text-body font-semibold text-ink">What survives a crash</h2>
          {result.open.length === 0 ? (
            <p className="text-label text-ink-dim">Every transaction ended, so this is the same table.</p>
          ) : (
            <>
              <p className="mb-2 text-label text-evict">
                {result.open.join(' and ')} never committed or rolled back — a crash would undo{' '}
                {result.open.length === 1 ? 'it' : 'them'}.
              </p>
              <RowsTable
                caption="accounts that survives a crash"
                columns={columns}
                rows={result.committed.tables.accounts?.rows ?? []}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
