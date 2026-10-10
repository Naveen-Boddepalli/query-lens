import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createAccountsDatabase } from '../../engine/index.ts';
import type { Database, Row } from '../../engine/index.ts';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../../engine/schedule.ts';
import type { LockingOptions, ScheduleStep, ScheduleStepResult } from '../../engine/schedule.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { decodeSchedule, encodeSchedule, MAX_STATEMENT_LENGTH, SESSIONS } from '../../ui/scheduleUrl.ts';
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

/**
 * plan.md §25.4 D1, D2: two sessions, one database, and an interleaving you choose. With *no locking* a statement
 * sees and changes whatever the database holds, uncommitted changes included, and `ROLLBACK` really undoes — the page
 * names what that lets through (a dirty read, a dirty write). With *page* or *row* locking the same schedule runs under
 * strict two-phase locking: a statement that cannot get its lock waits, and a deadlock rolls back the youngest.
 */

type LockingMode = 'none' | 'page' | 'row';
const LOCKING_MODES: { value: LockingMode; label: string }[] = [
  { value: 'none', label: 'No locking' },
  { value: 'page', label: 'Page locks' },
  { value: 'row', label: 'Row locks' },
];
const TABLE_SIZES = [3, 20] as const;
type TableSize = (typeof TABLE_SIZES)[number];

interface Preset {
  label: string;
  steps: ScheduleStep[];
  locking: LockingMode;
  rows: TableSize;
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

function readInitial(): { steps: ScheduleStep[]; locking: LockingMode; rows: TableSize } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const steps = decodeSchedule(params.get('s'));
  const lockingRaw = params.get('l');
  const rowsRaw = Number(params.get('n'));
  const locking: LockingMode = lockingRaw === 'page' || lockingRaw === 'row' ? lockingRaw : 'none';
  const rows: TableSize = rowsRaw === 20 ? 20 : 3;
  if (steps === null) return { steps: PRESETS[0]!.steps, locking: PRESETS[0]!.locking, rows: PRESETS[0]!.rows };
  return { steps, locking, rows };
}

const INITIAL = readInitial();

const PHASE_LABEL: Record<ScheduleStepResult['phase'], string | null> = {
  ran: null,
  queued: 'waiting behind its session',
  blocked: 'blocked on a lock',
  resumed: 'resumed',
  victim: 'deadlock victim',
};

function RowsTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: Row[] }) {
  if (rows.length === 0) return <p className="text-label text-ink-dim">{caption}: no rows.</p>;
  return (
    <div className="overflow-x-auto">
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
    </div>
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
                {l.holders.length > 0 && <> — held by {l.holders.map((h) => `${h.session} (${h.mode})`).join(', ')}</>}
                {l.waiters.length > 0 && (
                  <span className="text-evict"> — {l.waiters.map((w) => `${w.session} waits (${w.mode})`).join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
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
  const [session, setSession] = useState<SessionName>('A');
  const [sql, setSql] = useState('');

  const database = useMemo(() => createAccountsDatabase(rows), [rows]);
  const lockingOptions = useMemo<LockingOptions | undefined>(
    () => (locking === 'none' ? undefined : { granularity: locking }),
    [locking],
  );
  const result = useMemo(
    () => runSchedule(steps, database, undefined, lockingOptions),
    [steps, database, lockingOptions],
  );
  const columns = database.tables.accounts?.columns ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (steps.length > 0) params.set('s', encodeSchedule(steps));
      if (locking !== 'none') params.set('l', locking);
      if (rows !== 3) params.set('n', String(rows));
      const next = `${location.pathname}${params.size > 0 ? `?${params.toString()}` : ''}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [steps, locking, rows]);

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
        shows the lock table on its own.
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
            : locking === 'page'
              ? 'Strict two-phase locking, a lock per page: every row on a touched page is covered, so unrelated rows collide.'
              : rows === 3
                ? 'Strict two-phase locking, a lock per row. Three accounts fit one page and the planner scans them, so a scan examines every row and a row lock covers all three.'
                : 'Strict two-phase locking, a lock per row. With twenty accounts an id lookup goes through the index and touches one row, so its neighbours are free.'}
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
