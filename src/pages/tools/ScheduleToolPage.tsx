import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createAccountsDatabase } from '../../engine/index.ts';
import type { Database, Row } from '../../engine/index.ts';
import { MAX_SCHEDULE_STEPS, runSchedule } from '../../engine/schedule.ts';
import type { ScheduleStep, ScheduleStepResult } from '../../engine/schedule.ts';
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
 * plan.md §25.4 D1: two sessions, one database, and an interleaving you choose. The baseline here is *no concurrency
 * control at all* — a statement sees and changes whatever the database holds, uncommitted changes included, and
 * `ROLLBACK` really undoes. The page names what that lets through (a dirty read, a dirty write); locks, isolation
 * levels and MVCC are what prevent it, and they plug into the same schedule.
 */

const PRESETS: { label: string; steps: ScheduleStep[] }[] = [
  {
    label: 'Dirty read',
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
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { session: 'A', sql: 'ROLLBACK' },
    ],
  },
  {
    label: 'Commit, then read',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: "INSERT INTO accounts VALUES (4, 'di', 100)" },
      { session: 'B', sql: 'SELECT * FROM accounts' },
      { session: 'A', sql: 'COMMIT' },
      { session: 'B', sql: 'SELECT * FROM accounts' },
    ],
  },
];

const CONTROL: { label: string; sql: string }[] = [
  { label: 'BEGIN', sql: 'BEGIN' },
  { label: 'COMMIT', sql: 'COMMIT' },
  { label: 'ROLLBACK', sql: 'ROLLBACK' },
];

function readInitial(): ScheduleStep[] {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return decodeSchedule(params.get('s')) ?? PRESETS[0]!.steps;
}

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
  return (
    <div className={`${card} ${step.anomalies.length > 0 ? 'border-evict/60' : ''}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-label text-ink-dim">
          <span className={pill}>{step.session}</span>
          {step.kind !== 'statement' && <span className="font-mono">{label}</span>}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md px-1.5 text-label text-ink-dim hover:text-ink"
          aria-label={`Remove step ${String(step.index + 1)}`}
        >
          remove
        </button>
      </div>
      <code className="block break-words font-mono text-label text-ink">{step.sql}</code>

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

      <details className="mt-2">
        <summary className="cursor-pointer text-label text-ink-dim">The table after this step</summary>
        <div className="mt-1">
          <RowsTable
            caption={`accounts after step ${String(step.index + 1)}`}
            columns={columns}
            rows={step.after.tables.accounts?.rows ?? []}
          />
        </div>
      </details>
    </div>
  );
}

export function ScheduleToolPage() {
  const [steps, setSteps] = useState<ScheduleStep[]>(readInitial);
  const [session, setSession] = useState<SessionName>('A');
  const [sql, setSql] = useState('');

  const database = useMemo(() => createAccountsDatabase(), []);
  const result = useMemo(() => runSchedule(steps, database), [steps, database]);
  const columns = database.tables.accounts?.columns ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (steps.length > 0) params.set('s', encodeSchedule(steps));
      const next = `${location.pathname}${params.size > 0 ? `?${params.toString()}` : ''}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(timer); };
  }, [steps]);

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
        Two sessions, one database, and an interleaving you choose (plan.md §25.4 D1). There is{' '}
        <strong>no concurrency control here yet</strong>: a statement sees and changes whatever the
        table holds, another session&rsquo;s uncommitted work included, and <code>ROLLBACK</code> really
        undoes. The page names what that lets through. The{' '}
        <Link to="/tools/locks" className="underline underline-offset-2 hover:text-ink">
          locks sandbox
        </Link>{' '}
        is the first thing that will stop it.
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

      <div className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
        Examples
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => { setSteps(p.steps); }} className={btnSecondary}>
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
            {result.steps.map((step) => (
              <li
                key={step.index}
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
