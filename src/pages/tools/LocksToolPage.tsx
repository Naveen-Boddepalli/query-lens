import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { heldBy, waitingBy } from '../../ui/lockSimulation.ts';
import type { LockMode } from '../../ui/lockSimulation.ts';
import {
  decodeLockSteps,
  encodeLockSteps,
  LOCK_PAGES,
  LOCK_TRANSACTIONS,
  MAX_LOCK_STEPS,
  runLockSteps,
} from '../../ui/lockScript.ts';
import type { LockStep, LockTransaction } from '../../ui/lockScript.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
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
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * plan.md §22.2 "enforced concurrency" / §22.3 `/tools/locks`. Fixed at two
 * transactions — the plan's own "two transaction timelines" — placing real
 * lock requests against a handful of pages. `lockSimulation.ts` is the pure
 * driver; this page just applies one request or release at a time and
 * narrates what happened, the same shape `/tools/btree`'s insert/delete/find
 * already uses.
 *
 * What was done is a list of steps, not just where it ended: `lockScript.ts` folds the list over an empty lock
 * table, and the list travels in the URL (`s`), so a visit can be sent and a lesson can open the sandbox on the
 * situation it is about.
 */

const TRANSACTIONS = LOCK_TRANSACTIONS;
type Transaction = LockTransaction;
const RESOURCES: readonly number[] = LOCK_PAGES;
const MODES: LockMode[] = ['shared', 'exclusive'];

interface LogEntry {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'quiet';
}

/**
 * A single `request`/`release` call can return several narration lines that
 * mean quite different things — a deadlock's own outcome bundles the block,
 * the cycle, the victim's locks being released, *and* another transaction
 * being promoted into a lock it can finally hold. Colouring the whole bundle
 * by the call's one `kind` would paint that last, good-news line the same
 * alarming red as the deadlock itself, so each line is read on its own
 * words instead.
 */
function toneFor(text: string): LogEntry['tone'] {
  if (text.startsWith('Deadlock:')) return 'bad';
  if (text.includes('is granted') || text.includes('is promoted')) return 'good';
  return 'quiet';
}

const DEADLOCK_EXAMPLE: LockStep[] = [
  { op: 'request', transaction: 'T1', page: 0, mode: 'exclusive' },
  { op: 'request', transaction: 'T2', page: 1, mode: 'exclusive' },
  { op: 'request', transaction: 'T1', page: 1, mode: 'exclusive' },
  { op: 'request', transaction: 'T2', page: 0, mode: 'exclusive' },
];

/** The steps in the link, or none. */
function readInitialSteps(): LockStep[] {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return decodeLockSteps(params.get('s')) ?? [];
}

const INITIAL_STEPS = readInitialSteps();

export function LocksToolPage() {
  const [steps, setSteps] = useState<LockStep[]>(INITIAL_STEPS);
  const [transaction, setTransaction] = useState<Transaction>('T1');
  const [resource, setResource] = useState(0);
  const [mode, setMode] = useState<LockMode>('shared');

  const run = useMemo(() => runLockSteps(steps), [steps]);
  const state = run.state;
  const log: LogEntry[] = useMemo(
    () =>
      run.entries
        .flatMap((entry) => entry.lines)
        .map((text, id) => ({ id, text, tone: toneFor(text) })),
    [run],
  );
  const full = steps.length >= MAX_LOCK_STEPS;

  const shareQuery = useMemo(
    () => (steps.length > 0 ? `s=${encodeURIComponent(encodeLockSteps(steps))}` : ''),
    [steps],
  );
  useAddressBarQuery(shareQuery, 0);

  function add(step: LockStep) {
    if (full) return;
    setSteps((prev) => [...prev, step]);
  }

  function runRequest() {
    add({ op: 'request', transaction, page: resource, mode });
  }

  function runRelease(t: Transaction, r: number, m: LockMode) {
    add({ op: 'release', transaction: t, page: r, mode: m });
  }

  function runPreset() {
    setSteps(DEADLOCK_EXAMPLE);
  }

  function reset() {
    setSteps([]);
  }

  const totalHeld = Object.values(state.holders).reduce((acc, h) => acc + h.length, 0);
  const totalWaiting = Object.values(state.waiters).reduce((acc, w) => acc + w.length, 0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'Lock Manager' }]}
        title="Lock Manager Simulator"
      >
        Two transactions placing real lock requests against each other. A conflicting request
        genuinely <em>blocks</em> here &mdash; unlike the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        , which runs one query at a time. Form a dependency cycle and watch the wait-for graph
        resolve: the transaction that arrived more recently is aborted, releasing its held locks.
      </PageHeader>

      {/* Control Toolbar */}
      <div className="ql-sheen flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <div className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Transaction</span>
          <div className="flex gap-1" role="radiogroup" aria-label="Transaction">
            {TRANSACTIONS.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={transaction === t}
                onClick={() => { setTransaction(t); }}
                className={`${segBase} ${transaction === t ? segOn : segOff}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <label htmlFor="resource" className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Page Resource</span>
          <select
            id="resource"
            value={resource}
            onChange={(e) => { setResource(Number(e.target.value)); }}
            className={`${inputField} w-24 tabular-nums font-mono`}
          >
            {RESOURCES.map((r) => (
              <option key={r} value={r}>page {r}</option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Lock Mode</span>
          <div className="flex gap-1" role="radiogroup" aria-label="Lock mode">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => { setMode(m); }}
                className={`${segBase} capitalize ${mode === m ? segOn : segOff}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={runRequest} disabled={full} className={btnPrimary}>
            Request Lock
          </button>
          <button type="button" onClick={runPreset} className={btnSecondary}>
            Deadlock Example
          </button>
          <button type="button" onClick={reset} className={btnSecondary}>
            Reset
          </button>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Locks Held', value: String(totalHeld), sub: 'active grants', color: 'text-hit' },
          { label: 'Pending Waiters', value: String(totalWaiting), sub: 'blocked requests', color: totalWaiting > 0 ? 'text-miss' : 'text-ink' },
          {
            label: 'Deadlock Status',
            value: state.aborted.length > 0 ? `${state.aborted.join(', ')} Aborted` : 'None',
            sub: 'cycle resolution',
            color: state.aborted.length > 0 ? 'text-evict' : 'text-hit',
          },
          { label: 'Model', value: 'Strict 2PL', sub: 'Shared & Exclusive' },
        ].map((m) => (
          <div key={m.label} className="ql-sheen rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm">
            <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-dim">{m.label}</span>
            <span className={`mt-1 block truncate text-heading font-semibold tabular-nums ${m.color ?? 'text-ink'}`}>
              {m.value}
            </span>
            <span className="text-[0.75rem] text-ink-dim">{m.sub}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {RESOURCES.map((r) => {
          const holders = state.holders[r] ?? [];
          const waiters = state.waiters[r] ?? [];
          return (
            <div key={r} className={card}>
              <h3 className="mb-1 text-label font-semibold text-ink">page {r}</h3>
              {holders.length === 0 && waiters.length === 0 ? (
                <p className="text-label text-ink-dim">idle</p>
              ) : (
                <>
                  {holders.map((h) => (
                    <p key={`${h.transaction}-${h.mode}`} className="text-label text-hit">
                      {h.transaction} holds {h.mode}
                    </p>
                  ))}
                  {waiters.map((w) => (
                    <p key={`${w.transaction}-${w.mode}`} className="text-label text-ink-dim">
                      {w.transaction} waits {w.mode}
                    </p>
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TRANSACTIONS.map((t) => {
          const holds = heldBy(state, t);
          const waits = waitingBy(state, t);
          const aborted = state.aborted.includes(t);
          return (
            <div key={t} className={card}>
              <h3 className="mb-2 flex items-center gap-2 text-body font-semibold text-ink">
                {t}
                {aborted && (
                  <span className="rounded-full border border-evict/50 px-2 py-0.5 text-label text-evict">
                    aborted
                  </span>
                )}
              </h3>
              <p className="mb-1 text-label text-ink-dim">Holds</p>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {holds.length === 0 && <span className="text-label text-ink-dim">(nothing)</span>}
                {holds.map(({ resource: r, mode: m }) => (
                  <button
                    key={`${r}-${m}`}
                    type="button"
                    onClick={() => { runRelease(t, r, m); }}
                    className={`${pill} hover:border-accent hover:text-ink`}
                    title={`Release ${t}'s ${m} lock on page ${r}`}
                  >
                    page {r} · {m} · release
                  </button>
                ))}
              </div>
              <p className="mb-1 text-label text-ink-dim">Waiting for</p>
              <div className="flex flex-wrap gap-1.5">
                {waits.length === 0 && <span className="text-label text-ink-dim">(nothing)</span>}
                {waits.map(({ resource: r, mode: m }) => (
                  <span key={`${r}-${m}`} className={pill}>
                    page {r} · {m}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className={`${panelSurface} min-h-48 flex-1 overflow-y-auto p-4`}>
        <h3 className="mb-2 text-body font-semibold text-ink">Timeline</h3>
        {log.length === 0 ? (
          <p className="text-label text-ink-dim">Place a request to begin, or try the deadlock example.</p>
        ) : (
          <ol className="space-y-1 text-label" aria-live="polite">
            {log.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.tone === 'bad' ? 'text-evict' : entry.tone === 'good' ? 'text-hit' : 'text-ink-dim'
                }
              >
                {entry.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
