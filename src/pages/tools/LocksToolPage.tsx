import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { heldBy, waitingBy } from '../../ui/lockSimulation.ts';
import type { LockMode } from '../../ui/lockSimulation.ts';
import { compatibilityMatrix, LOCK_MODES, MODE_SHORT, modeName, RIGHTS } from '../../engine/locks/lockTable.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import {
  decodeLockSteps,
  encodeLockSteps,
  LOCK_PAGES,
  LOCK_TRANSACTIONS,
  MAX_LOCK_STEPS,
  runLockSteps,
} from '../../ui/lockScript.ts';
import type { LockStep, LockTransaction } from '../../ui/lockScript.ts';
import { controlLabel, inputField, pill } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  CommandBar,
  Inspector,
  MetricStrip,
  ScenarioPicker,
  Segmented,
  StagePanel,
  ToolHeader,
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * plan.md §22.2 "enforced concurrency" / §22.3 `/tools/locks`. Fixed at two
 * transactions — the plan's own "two transaction timelines" — placing real
 * lock requests against a handful of pages. `lockSimulation.ts` is the pure
 * driver; this page just applies one request or release at a time and
 * narrates what happened, the same shape `/tools/btree`'s insert/delete/find
 * already uses.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): worked examples in the inspector's scenario picker (the old
 * "Deadlock example" button was a scenario drawn as an action), the next request's transaction, page and mode in the
 * command bar with Request as the one primary, the lock table on the stage, and the timeline and the compatibility
 * matrix as sections below.
 *
 * What was done is a list of steps, not just where it ended: `lockScript.ts` folds the list over an empty lock
 * table, and the list travels in the URL (`s`), so a visit can be sent and a lesson can open the sandbox on the
 * situation it is about.
 */

const TRANSACTIONS = LOCK_TRANSACTIONS;
type Transaction = LockTransaction;
const RESOURCES: readonly number[] = LOCK_PAGES;
const MODES: readonly LockMode[] = LOCK_MODES;


/** What each mode does, in the words the matrix is computed from (plan.md §27.5 T2). A lock on the whole covers below. */
const WHOLE_WORDS = ['nothing on the page itself', 'reads the whole page', 'writes the whole page'] as const;
const BELOW_WORDS = ['', 'means to read rows below', 'means to write rows below'] as const;

/**
 * The compatibility matrix, computed by the engine from what each mode lets its holder do — not a table typed in. On
 * this sandbox's pages the "below" is the rows of a page.
 */
function CompatibilityMatrix() {
  const cells = compatibilityMatrix();
  return (
    <ToolSection
      title="Which modes can share a page"
      description="Computed, not drawn: each mode is what it lets its holder do to the whole page and to the rows below it, and two modes conflict when one writes something the other reads or writes. The intention modes touch nothing on the page itself (they say what will be locked below, where a real conflict waits), so IS and IX never wait for each other."
    >
      <ScrollRegion label="Lock modes and their compatibility" className="overflow-x-auto">
        <table className="w-full text-left text-label">
          <caption className="sr-only">Compatibility of a mode held (row) with a mode requested (column)</caption>
          <thead className="text-ink-dim">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Held \ requested</th>
              {LOCK_MODES.map((m) => (
                <th key={m} scope="col" className="py-1 pr-3 font-mono font-medium">{MODE_SHORT[m]}</th>
              ))}
              <th scope="col" className="py-1 font-medium">What it does</th>
            </tr>
          </thead>
          <tbody>
            {LOCK_MODES.map((held) => (
              <tr key={held} className="border-t border-edge">
                <th scope="row" className="py-1 pr-3 font-mono font-medium text-ink">{MODE_SHORT[held]}</th>
                {LOCK_MODES.map((requested) => {
                  const ok = cells.find((c) => c.held === held && c.requested === requested)!.compatible;
                  return (
                    <td key={requested} className={`py-1 pr-3 font-mono ${ok ? 'text-hit' : 'text-evict'}`}>
                      <span aria-hidden>{ok ? '✓' : '✗'}</span>
                      <span className="sr-only">{ok ? 'compatible' : 'conflicts'}</span>
                    </td>
                  );
                })}
                <td className="py-1 text-ink-dim">
                  {held}: {[WHOLE_WORDS[RIGHTS[held].whole], BELOW_WORDS[RIGHTS[held].below]].filter(Boolean).join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </ToolSection>
  );
}

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

const req = (transaction: Transaction, page: number, mode: LockMode): LockStep => ({ op: 'request', transaction, page, mode });

/** Worked examples, each a script of steps. Any step after picking one reads "Custom". */
const SCENARIOS: readonly { id: string; title: string; blurb: string; steps: readonly LockStep[] }[] = [
  { id: 'empty', title: 'An empty lock table', blurb: 'Nothing held and nothing waiting. Place requests one at a time.', steps: [] },
  {
    id: 'readers',
    title: 'Two readers',
    blurb: 'T1 and T2 both read page 0: shared locks are compatible, so neither waits.',
    steps: [req('T1', 0, 'shared'), req('T2', 0, 'shared')],
  },
  {
    id: 'writer-waits',
    title: 'A writer waits',
    blurb: 'T2 asks to write a page T1 is reading: the exclusive request waits until T1 lets go.',
    steps: [req('T1', 0, 'shared'), req('T2', 0, 'exclusive')],
  },
  {
    id: 'intention',
    title: 'Intention locks',
    blurb: 'IX and IS on one page: both only announce what will be locked below, so they share it.',
    steps: [req('T1', 0, 'intention-exclusive'), req('T2', 0, 'intention-shared')],
  },
  {
    id: 'deadlock',
    title: 'Deadlock',
    blurb: 'Each holds the page the other wants. The wait-for graph finds the cycle and aborts the later arrival.',
    steps: [req('T1', 0, 'exclusive'), req('T2', 1, 'exclusive'), req('T1', 1, 'exclusive'), req('T2', 0, 'exclusive')],
  },
];

const sameSteps = (a: readonly LockStep[], b: readonly LockStep[]) => encodeLockSteps(a) === encodeLockSteps(b);

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

  function reset() {
    setSteps([]);
  }

  const totalHeld = Object.values(state.holders).reduce((acc, h) => acc + h.length, 0);
  const totalWaiting = Object.values(state.waiters).reduce((acc, w) => acc + w.length, 0);
  const scenario = SCENARIOS.find((sc) => sameSteps(sc.steps, steps));
  const lastLines = run.entries.at(-1)?.lines ?? [];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="transactions"
        header={
          <ToolHeader
            id="locks"
            title="Locks sandbox"
            summary="Two transactions request locks on the same pages: conflicts block, and a deadlock is found and broken."
            about={
              <p>
                A conflicting request genuinely blocks here, unlike the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>
                , which runs one query at a time. Form a cycle of waits and the wait-for graph finds it: the transaction
                that arrived more recently is aborted, and its locks are released. Every step is kept in the address, so
                the page can be sent as it stands.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(steps.length)} step${steps.length === 1 ? '' : 's'} · ${scenario ? scenario.title : 'custom'}`}>
            <ScenarioPicker
              id="locks-scenario"
              scenarios={SCENARIOS}
              value={scenario?.id ?? null}
              onPick={(id) => {
                const picked = SCENARIOS.find((sc) => sc.id === id);
                if (picked) setSteps([...picked.steps]);
              }}
            />
          </Inspector>
        }
        command={
          <CommandBar
            primary={{ label: 'Request lock', onClick: runRequest, disabled: full, ...(full ? { title: `At most ${String(MAX_LOCK_STEPS)} steps` } : {}) }}
            secondary={[{ label: 'Reset', onClick: reset, disabled: steps.length === 0 }]}
          >
            <div className="flex flex-col gap-1">
              <span id="locks-txn" className={controlLabel}>Transaction</span>
              <Segmented
                labelledBy="locks-txn"
                tone="stage"
                value={transaction}
                onChange={setTransaction}
                options={TRANSACTIONS.map((t) => ({ value: t, label: t }))}
              />
            </div>
            <label htmlFor="resource" className={`flex flex-col gap-1 ${controlLabel}`}>
              Page
              <select
                id="resource"
                value={resource}
                onChange={(e) => { setResource(Number(e.target.value)); }}
                className={`${inputField} font-mono tabular-nums`}
              >
                {RESOURCES.map((r) => (
                  <option key={r} value={r}>page {r}</option>
                ))}
              </select>
            </label>
            <div className="flex min-w-0 flex-col gap-1">
              <span id="locks-mode" className={controlLabel}>Lock mode</span>
              <Segmented
                labelledBy="locks-mode"
                tone="stage"
                value={mode}
                onChange={setMode}
                options={MODES.map((m) => ({ value: m, label: <span className="font-mono">{MODE_SHORT[m]}</span>, ariaLabel: m }))}
              />
            </div>
          </CommandBar>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Locks held', value: totalHeld, ...(totalHeld > 0 ? { tone: 'hit' as const } : {}) },
              { label: 'Waiting', value: totalWaiting, sub: 'blocked requests', ...(totalWaiting > 0 ? { tone: 'miss' as const } : {}) },
              {
                label: 'Aborted',
                value: state.aborted.length > 0 ? state.aborted.join(', ') : 'none',
                sub: state.aborted.length > 0 ? 'to break a deadlock' : 'no deadlock',
                ...(state.aborted.length > 0 ? { tone: 'evict' as const } : {}),
              },
              { label: 'Steps', value: steps.length, sub: `of ${String(MAX_LOCK_STEPS)}` },
            ]}
          />
        }
        stage={
          <StagePanel title="Lock table" legend="Who holds and who waits, on each page and for each transaction. Click a held lock to release it.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {RESOURCES.map((r) => {
                const holders = state.holders[r] ?? [];
                const waiters = state.waiters[r] ?? [];
                return (
                  <div key={r} className="min-w-0 rounded-lg border border-edge/70 p-3">
                    <h4 className="mb-1 font-mono text-label font-semibold text-ink">page {r}</h4>
                    {holders.length === 0 && waiters.length === 0 ? (
                      <p className="text-label text-ink-dim">idle</p>
                    ) : (
                      <>
                        {holders.map((h) => (
                          <p key={`${h.transaction}-${h.mode}`} className="text-label text-hit">
                            {h.transaction} holds {modeName(h.mode)}
                          </p>
                        ))}
                        {waiters.map((w) => (
                          <p key={`${w.transaction}-${w.mode}`} className="text-label text-ink-dim">
                            {w.transaction} waits {modeName(w.mode)}
                          </p>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {TRANSACTIONS.map((t) => {
                const holds = heldBy(state, t);
                const waits = waitingBy(state, t);
                const aborted = state.aborted.includes(t);
                return (
                  <div key={t} className="min-w-0 rounded-lg border border-edge/70 p-3">
                    <h4 className="mb-2 flex items-center gap-2 text-body font-semibold text-ink">
                      {t}
                      {aborted && <span className="rounded-full border border-evict/50 px-2 py-0.5 text-label text-evict">aborted</span>}
                    </h4>
                    <p className="mb-1 text-label text-ink-dim">Holds</p>
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {holds.length === 0 && <span className="text-label text-ink-dim">(nothing)</span>}
                      {holds.map(({ resource: r, mode: m }) => (
                        <button
                          key={`${r}-${m}`}
                          type="button"
                          onClick={() => { runRelease(t, r, m); }}
                          disabled={full}
                          className={`${pill} hover:border-accent hover:text-ink`}
                          title={`Release ${t}'s ${modeName(m)} lock on page ${String(r)}`}
                        >
                          page {r} · {modeName(m)} · release
                        </button>
                      ))}
                    </div>
                    <p className="mb-1 text-label text-ink-dim">Waiting for</p>
                    <div className="flex flex-wrap gap-1.5">
                      {waits.length === 0 && <span className="text-label text-ink-dim">(nothing)</span>}
                      {waits.map(({ resource: r, mode: m }) => (
                        <span key={`${r}-${m}`} className={pill}>
                          page {r} · {modeName(m)}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </StagePanel>
        }
        narration={lastLines.length > 0 ? lastLines.join(' ') : 'Place a request to begin, or load a scenario such as the deadlock.'}
      >
        <ToolSection title="Timeline" description="Every request and release so far, and what each one did.">
          {log.length === 0 ? (
            <p className="text-label text-ink-dim">No steps yet.</p>
          ) : (
            <ol className="space-y-1 text-label">
              {log.map((entry) => (
                <li
                  key={entry.id}
                  className={entry.tone === 'bad' ? 'text-evict' : entry.tone === 'good' ? 'text-hit' : 'text-ink-dim'}
                >
                  {entry.text}
                </li>
              ))}
            </ol>
          )}
        </ToolSection>
        <CompatibilityMatrix />
      </ToolShell>
    </div>
  );
}
