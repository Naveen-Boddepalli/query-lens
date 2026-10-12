import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { compareProtocols, PROTOCOLS } from '../../engine/concurrencyCompare.ts';
import type { ProtocolId, ProtocolOutcome } from '../../engine/concurrencyCompare.ts';
import type { ScheduleStep } from '../../engine/schedule.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, panelSurface, pill, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { decodeSchedule, encodeSchedule, SESSIONS } from '../../ui/scheduleUrl.ts';
import { DataView } from '../../ui/DataView.tsx';
import { StepList } from '../../ui/ScheduleStepList.tsx';
import { SCHEDULE_COLUMNS, scheduleRows } from '../../ui/transactionTables.ts';

/**
 * plan.md §25.4 D6: one schedule, run under every concurrency-control protocol the schedule runner implements. The
 * table is a bill read off those runs — who waited, who was thrown away and with how much work, what was let
 * through, and whether what survived is what running the committed transactions one at a time would have left.
 * Every row opens the run behind it.
 */

interface Preset {
  label: string;
  /** What to look for. */
  lookFor: string;
  steps: ScheduleStep[];
}

const PRESETS: Preset[] = [
  {
    label: 'Lost update',
    lookFor: 'Both read 100 and both want to write over it. Who waits, and who is thrown away?',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 110 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 120 WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
      { session: 'B', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Write skew',
    lookFor: 'Each reads both rows and writes a different one. Only the snapshot row lets both commit, and the check names it.',
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
    label: 'Reader and writer',
    lookFor: 'A reads the whole table; B changes one row. Does the reader make the writer wait?',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE balance > 50' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 5 WHERE id = 1' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Read skew',
    lookFor: 'A reads one row, B changes it and another, A reads the other: two halves of different states.',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'B', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = 150 WHERE id = 2' },
      { session: 'B', sql: 'COMMIT' },
      { session: 'A', sql: 'SELECT balance FROM accounts WHERE id = 2' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Phantom',
    lookFor: 'A asks the same question twice while B adds a row that answers it.',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE balance > 50' },
      { session: 'B', sql: "INSERT INTO accounts VALUES (30, 'zed', 100)" },
      { session: 'A', sql: 'SELECT * FROM accounts WHERE balance > 50' },
      { session: 'A', sql: 'COMMIT' },
    ],
  },
  {
    label: 'Deadlock',
    lookFor: 'Each holds what the other wants. Locking has to break a cycle; the others never form one.',
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
  {
    label: 'Built on a rollback',
    lookFor: 'B adds one to a balance A set and then abandoned. Only a strict protocol refuses to build on it.',
    steps: [
      { session: 'A', sql: 'BEGIN' },
      { session: 'A', sql: 'UPDATE accounts SET balance = 0 WHERE id = 1' },
      { session: 'B', sql: 'UPDATE accounts SET balance = balance + 1 WHERE id = 1' },
      { session: 'A', sql: 'ROLLBACK' },
    ],
  },
];

const TABLE_SIZES = [3, 20] as const;
type TableSize = (typeof TABLE_SIZES)[number];

function readInitial(): { steps: ScheduleStep[]; rows: TableSize; selected: ProtocolId } {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const steps = decodeSchedule(params.get('s'));
  const rows: TableSize = Number(params.get('n')) === 3 ? 3 : 20;
  const picked = PROTOCOLS.find((p) => p.id === params.get('p'));
  return { steps: steps ?? PRESETS[0]!.steps, rows, selected: picked?.id ?? 'two-phase' };
}

const INITIAL = readInitial();

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function ordinalOrder(order: 'commit' | 'begin'): string {
  return order === 'commit' ? 'the order they committed' : 'the order they began';
}

/** Short enough for a table cell: what, if anything, a run let through. */
function anomalyText(o: ProtocolOutcome): string {
  return o.anomalies.length === 0 ? 'none flagged' : o.anomalies.join(', ');
}

function Verdict({ outcome }: { outcome: ProtocolOutcome }) {
  const { check, protocol } = outcome;
  const count = check.order.length;
  if (outcome.serializable) {
    return (
      <p className="text-label text-ink">
        {count === 0
          ? 'Nothing committed, and nothing that survived differs from the start.'
          : count === 1
            ? 'One transaction committed, so there is only one order, and it explains the run.'
            : `Run one after another, ${(check.found ?? check.order).join(', then ')} explains it: each statement returns and affects what it did here, and the table that is left is the one that order leaves.`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-label text-ink">
      <p className="text-evict">
        {outcome.check.exhaustive
          ? `No order of the ${String(count)} committed transactions explains this run: every order has a statement that would have answered differently, or leaves a different table.`
          : `No order of the ${String(count)} committed transactions was found that explains this run; the search was cut off before it covered them all.`}
      </p>
      {check.differentRead && (
        <p className="text-ink-dim">
          In {ordinalOrder(protocol.order)}, the first to disagree is {check.differentRead.session}&rsquo;s{' '}
          <code className="font-mono">{check.differentRead.sql}</code>: it returned{' '}
          <code className="font-mono">{JSON.stringify(check.differentRead.saw)}</code>, and there it would have returned{' '}
          <code className="font-mono">{JSON.stringify(check.differentRead.serialSaw)}</code>.
        </p>
      )}
      {!check.sameTable && (
        <p className="text-ink-dim">
          The table that survived is not the one that order leaves: something a transaction that did not commit had
          written is still in it.
        </p>
      )}
      {protocol.claimsSerializable && outcome.anomalies.length > 0 && (
        <p className="text-ink-dim">
          {protocol.label} is not strict, so a transaction can act on a change another one then rolls back — the{' '}
          {outcome.anomalies.join(' and ')} flagged below.
        </p>
      )}
      {!protocol.claimsSerializable && (
        <p className="text-ink-dim">{protocol.label} does not promise serializability; this is what it lets through.</p>
      )}
    </div>
  );
}

export function ConcurrencyToolPage() {
  const [steps, setSteps] = useState<ScheduleStep[]>(INITIAL.steps);
  const [rows, setRows] = useState<TableSize>(INITIAL.rows);
  const [selectedId, setSelectedId] = useState<ProtocolId>(INITIAL.selected);

  const outcomes = useMemo(() => compareProtocols(steps, rows), [steps, rows]);
  const selected = outcomes.find((o) => o.protocol.id === selectedId) ?? outcomes[0]!;
  const preset = PRESETS.find((p) => JSON.stringify(p.steps) === JSON.stringify(steps));

  useEffect(() => {
    const params = new URLSearchParams();
    if (steps.length > 0) params.set('s', encodeSchedule(steps));
    if (rows !== 20) params.set('n', String(rows));
    if (selectedId !== 'two-phase') params.set('p', selectedId);
    const next = `${location.pathname}${params.size > 0 ? `?${params.toString()}` : ''}`;
    if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
  }, [steps, rows, selectedId]);

  const editParams = new URLSearchParams();
  if (steps.length > 0) editParams.set('s', encodeSchedule(steps));
  editParams.set('l', 'row');
  editParams.set('i', 'serializable');
  if (rows !== 3) editParams.set('n', String(rows));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Concurrency-control compare">
        One schedule, five ways to keep it correct (plan.md §25.4 D6): locks that make a statement wait, timestamps that
        abort what arrives too late, validation that checks at <code>COMMIT</code>, and snapshots with and without a
        read check. Each row is that protocol actually running the schedule below; the table is its bill. Edit the
        schedule, or build your own, in the{' '}
        <Link to={`/tools/schedule?${editParams.toString()}`} className="underline underline-offset-2 hover:text-ink">
          transaction schedules
        </Link>{' '}
        tool.
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
        Examples
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={preset === p}
            onClick={() => { setSteps(p.steps); }}
            className={`${btnSecondary} ${preset === p ? 'border-accent' : ''}`}
          >
            {p.label}
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-edge" aria-hidden />
        <span>Accounts</span>
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

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-1 text-body font-semibold text-ink">The schedule</h2>
        {preset && <p className="mb-3 text-label text-ink-dim">{preset.lookFor}</p>}
        {steps.length === 0 ? (
          <p className="text-label text-ink-dim">Empty. Load an example.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map((step, i) => (
              <li key={i} className="grid grid-cols-[2rem_1fr_1fr] items-baseline gap-2 text-label">
                <span className="tabular-nums text-ink-dim">{i + 1}.</span>
                {SESSIONS.map((lane) =>
                  lane === step.session ? (
                    <span key={lane} className="flex min-w-0 items-baseline gap-2">
                      <span className={pill}>{lane}</span>
                      <code className="min-w-0 break-words font-mono text-ink">{step.sql}</code>
                    </span>
                  ) : (
                    <span key={lane} aria-hidden />
                  ),
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-1 text-body font-semibold text-ink">What each protocol did</h2>
        <p className="mb-2 text-label text-ink-dim">
          Counted off the runs below. A statement outside a transaction is one of its own. Choose a row to see its rule,
          its verdict, and the run itself.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-label">
            <caption className="sr-only">The same schedule under each concurrency-control protocol</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="py-1 pr-3 font-medium">Protocol</th>
                <th scope="col" className="px-2 py-1 font-medium">Committed</th>
                <th scope="col" className="px-2 py-1 font-medium">Aborted</th>
                <th scope="col" className="px-2 py-1 font-medium">Waits</th>
                <th scope="col" className="px-2 py-1 font-medium">Work lost</th>
                <th scope="col" className="px-2 py-1 font-medium">Let through</th>
                <th scope="col" className="px-2 py-1 font-medium">One at a time?</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => {
                const isSelected = o.protocol.id === selected.protocol.id;
                return (
                  <tr key={o.protocol.id} className={isSelected ? 'bg-surface-2' : ''}>
                    <th scope="row" className="py-1 pr-3 font-normal">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => { setSelectedId(o.protocol.id); }}
                        className={`rounded-md border px-2 py-1 text-left text-ink ${isSelected ? 'border-accent' : 'border-edge'}`}
                      >
                        {o.protocol.label}
                      </button>
                    </th>
                    <td className="px-2 py-1 tabular-nums text-ink">{o.committed}</td>
                    <td className={`px-2 py-1 tabular-nums ${o.aborted.length > 0 ? 'text-evict' : 'text-ink'}`}>
                      {o.aborted.length}
                    </td>
                    <td className="px-2 py-1 tabular-nums text-ink">
                      {o.waits}
                      {o.result.deadlocks > 0 ? ` (${plural(o.result.deadlocks, 'deadlock')})` : ''}
                    </td>
                    <td className="px-2 py-1 tabular-nums text-ink">{plural(o.wasted, 'statement')}</td>
                    <td className={`px-2 py-1 ${o.anomalies.length > 0 ? 'text-evict' : 'text-ink-dim'}`}>
                      {anomalyText(o)}
                    </td>
                    <td className={`px-2 py-1 ${o.serializable ? 'text-hit' : 'text-evict'}`}>
                      {o.serializable ? 'Yes' : o.check.exhaustive ? 'No' : 'None found'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`${panelSurface} p-4`} role="region" aria-label={`The run under ${selected.protocol.label}`}>
        <h2 className="text-body font-semibold text-ink">{selected.protocol.label}</h2>
        <p className="mt-1 text-label text-ink">{selected.protocol.rule}</p>
        <p className="mt-1 text-label text-ink-dim">It costs: {selected.protocol.price}</p>

        <div className="mt-3 flex flex-col gap-2" role="status">
          <Verdict outcome={selected} />
          {selected.aborted.length > 0 && (
            <ul className="list-disc pl-5 text-label text-ink-dim">
              {selected.aborted.map((t, i) => (
                <li key={i}>
                  <span className="text-ink">{t.session}</span> was aborted
                  {t.statements.length > 0 ? `, after ${plural(t.statements.length, 'statement')}` : ''}: {t.reason}
                </li>
              ))}
            </ul>
          )}
          {selected.rolledBack > 0 && (
            <p className="text-label text-ink-dim">
              {plural(selected.rolledBack, 'transaction')} ended with its own <code>ROLLBACK</code>.
            </p>
          )}
          <p className="text-label text-ink">
            {selected.changes.length === 0
              ? 'The table ends as it began.'
              : `The table ends with: ${selected.changes.join('; ')}.`}
          </p>
        </div>

        <div className="mt-3">
          <DataView
            caption={`The run under ${selected.protocol.label}, one row for each thing that happened`}
            columns={SCHEDULE_COLUMNS}
            rows={scheduleRows(selected.result.steps)}
            keyOf={(r, i) => `${String(i)}-${String(r.n)}`}
          >
            <StepList steps={selected.result.steps} />
          </DataView>
        </div>
      </div>
    </div>
  );
}
