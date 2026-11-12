import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  allKeys,
  createTree,
  deleteKey,
  descend,
  height,
  insert,
  search,
  toIndexDisplay,
  validate,
} from '../../engine/index.ts';
import type { BPlusTree, DeleteStep } from '../../engine/index.ts';
import { BTreePanel } from '../../ui/panels/BTreePanel.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The DSA-course standalone (plan.md §20.4, §21.3). The pipeline builds one of
 * these for an indexed column; here it stands alone, with `insert`, the new
 * `deleteKey` (underflow → borrow / merge / root-collapse, plan.md §7.6), and
 * `search` driven straight off a number pad. `validate` runs after every edit
 * and is shown — if it ever reports a problem, that is a real bug surfaced,
 * not decoration.
 *
 * The tree re-renders whole after each operation rather than animating the
 * restructure step by step: that would need `index`-stage event kinds for
 * split / borrow / merge, which is its own piece of work. `find` highlights
 * the root-to-leaf path it walked; `delete` highlights the nodes it touched,
 * with `deleteKey`'s own step log narrated below.
 *
 * URL state: `keys` (the contents) and `fanout` (`maxKeys`), both parsed
 * defensively — a pasted link is a stranger's input, the same rule
 * `urlState.ts` follows.
 */

const MIN_FANOUT = 3;
const MAX_FANOUT = 6;
const MAX_KEYS_IN_TREE = 200;
const SAMPLE = [10, 20, 30, 40, 50, 15, 25, 35, 5, 45, 12, 28, 33, 48];

const pointerFor = (key: number) => ({ pageId: Math.abs(key) >> 2, slot: Math.abs(key) & 3 });

function build(keys: number[], fanout: number): BPlusTree {
  const tree = createTree(fanout, 0);
  keys.forEach((k) => { insert(tree, k, pointerFor(k)); });
  return tree;
}

function readInitial() {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const rawKeys = (params.get('keys') ?? '')
    .split(/[\s,]+/)
    .filter((t) => t.length > 0) // Number('') is 0 — drop blanks before parsing
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .slice(0, MAX_KEYS_IN_TREE);
  const fanoutRaw = Number(params.get('fanout'));
  const fanout =
    Number.isInteger(fanoutRaw) && fanoutRaw >= MIN_FANOUT && fanoutRaw <= MAX_FANOUT
      ? fanoutRaw
      : 4;
  const source = rawKeys.length > 0 ? rawKeys : SAMPLE;
  const keys = [...new Set(source)].sort((a, b) => a - b);
  return { keys, fanout };
}

const INITIAL = readInitial();

/** `deleteKey`'s step log as one sentence. */
function narrateSteps(key: number, steps: DeleteStep[]): string {
  const rest = steps.slice(1); // step 0 is always the `remove`
  const phrase = (s: DeleteStep): string => {
    switch (s.kind) {
      case 'update-separator':
        return `a separator in ${s.node} was rewritten (${s.detail ?? ''})`;
      case 'borrow-left':
        return `${s.node} borrowed a key from its left sibling`;
      case 'borrow-right':
        return `${s.node} borrowed a key from its right sibling`;
      case 'merge':
        return `${s.node} ${s.detail ?? 'merged with a sibling'}`;
      case 'root-collapse':
        return `the root collapsed into ${s.node}`;
      default:
        return s.kind;
    }
  };

  const rebalanced = rest.some((s) => s.kind !== 'update-separator');
  if (rest.length === 0) {
    return `Removed ${key}. The leaf stayed at least half full, so nothing else moved.`;
  }
  if (!rebalanced) {
    return `Removed ${key} — it was a separator, so ${phrase(rest[0]!)}. The leaf itself stayed at least half full.`;
  }
  return `Removed ${key}, and the leaf underflowed: ${rest.map(phrase).join(', then ')}.`;
}

export function BTreeToolPage() {
  const [keys, setKeys] = useState<number[]>(INITIAL.keys);
  const [fanout, setFanout] = useState(INITIAL.fanout);
  const [keyInput, setKeyInput] = useState('');
  const [message, setMessage] = useState('Insert, delete or find a key. The tree rebalances as you go.');
  const [highlight, setHighlight] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<'found' | 'not-found' | null>(null);

  const tree = useMemo(() => build(keys, fanout), [keys, fanout]);
  const display = useMemo(() => toIndexDisplay(tree), [tree]);
  const problems = useMemo(() => validate(tree), [tree]);
  const treeKeys = useMemo(() => allKeys(tree) as number[], [tree]);

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('keys', keys.join(','));
    params.set('fanout', String(fanout));
    return params.toString();
  }, [keys, fanout]);
  useAddressBarQuery(shareQuery);

  const parseKey = (): number | null => {
    const n = Number(keyInput.trim());
    return keyInput.trim() !== '' && Number.isInteger(n) ? n : null;
  };

  function runInsert() {
    const k = parseKey();
    if (k === null) { setMessage('Type a whole number first.'); return; }
    if (treeKeys.includes(k)) { setMessage(`${k} is already in the tree.`); return; }

    const nodesBefore = Object.keys(tree.nodes).length;
    const hBefore = height(tree);
    const next = [...keys, k].sort((a, b) => a - b);
    const grown = build(next, fanout);
    const nodesAfter = Object.keys(grown.nodes).length;
    const hAfter = height(grown);

    setKeys(next);
    setHighlight(descend(grown, k));
    setOutcome(null);
    setMessage(
      nodesAfter === nodesBefore
        ? `Inserted ${k} into an existing leaf — no split.`
        : `Inserted ${k}. A split added ${nodesAfter - nodesBefore} node${nodesAfter - nodesBefore === 1 ? '' : 's'}` +
          (hAfter > hBefore ? `, and the tree grew to height ${hAfter}.` : '.'),
    );
  }

  function runDelete() {
    const k = parseKey();
    if (k === null) { setMessage('Type a whole number first.'); return; }

    const working = structuredClone(tree);
    const res = deleteKey(working, k);
    if (!res.found) { setMessage(`${k} is not in the tree.`); return; }

    setKeys(keys.filter((x) => x !== k));
    setHighlight([...new Set(res.steps.map((s) => s.node))]);
    setOutcome(null);
    setMessage(narrateSteps(k, res.steps));
  }

  function runFind() {
    const k = parseKey();
    if (k === null) { setMessage('Type a whole number first.'); return; }

    const res = search(tree, k);
    setHighlight(res.path);
    setOutcome(res.pointer ? 'found' : 'not-found');
    setMessage(
      res.pointer
        ? `Found ${k} after ${res.path.length} node read${res.path.length === 1 ? '' : 's'} → row pointer page ${res.pointer.pageId}, slot ${res.pointer.slot}.`
        : `${k} is not in the tree. The search still cost ${res.path.length} node read${res.path.length === 1 ? '' : 's'} to prove it.`,
    );
  }

  function reseed(next: number[]) {
    setKeys([...new Set(next)].sort((a, b) => a - b));
    setHighlight([]);
    setOutcome(null);
    setMessage(next.length === 0 ? 'Empty tree — a single leaf that is also the root.' : `Loaded ${next.length} keys.`);
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'B+Tree' }]}
        title="B+Tree sandbox"
      >
        Insert, delete, and search keys against a live B+Tree — the same structure the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>{' '}
        builds for an indexed column, here with nothing else attached. Watch it split on insert,
        and borrow from a sibling or merge on delete.
      </PageHeader>

      {/* Control Toolbar */}
      <div className="ql-sheen flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <label htmlFor="fanout" className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Fan-out <span className="text-ink-dim/60 font-mono text-[0.75rem]">(max keys/node)</span></span>
          <select
            id="fanout"
            value={fanout}
            onChange={(e) => {
              setFanout(Number(e.target.value));
              setHighlight([]);
              setOutcome(null);
              setMessage(`Rebuilt tree at fan-out ${e.target.value}.`);
            }}
            className={`${inputField} w-24 tabular-nums`}
          >
            {Array.from({ length: MAX_FANOUT - MIN_FANOUT + 1 }, (_, i) => MIN_FANOUT + i).map((n) => (
              <option key={n} value={n}>{n} keys</option>
            ))}
          </select>
        </label>

        <label htmlFor="key" className="flex flex-col gap-1.5 text-label text-ink-dim">
          <span>Key</span>
          <input
            id="key"
            type="text"
            inputMode="numeric"
            placeholder="e.g. 25"
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') runFind(); }}
            className={`${inputField} w-28 font-mono tabular-nums`}
            spellCheck={false}
          />
        </label>

        <div className="flex items-center gap-1.5">
          <button type="button" onClick={runInsert} className={btnPrimary}>
            Insert
          </button>
          <button type="button" onClick={runDelete} className={btnSecondary}>
            Delete
          </button>
          <button type="button" onClick={runFind} className={btnSecondary}>
            Find
          </button>
        </div>

        <span className="mx-1 hidden h-6 w-px bg-edge sm:inline-block" aria-hidden="true" />

        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => { reseed(SAMPLE); }} className={btnSecondary}>
            Sample
          </button>
          <button
            type="button"
            onClick={() => { reseed(Array.from({ length: 20 }, (_, i) => i + 1)); }}
            className={btnSecondary}
          >
            1&ndash;20
          </button>
          <button type="button" onClick={() => { reseed([]); }} className={btnSecondary}>
            Clear
          </button>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: 'Tree Height', value: String(height(tree)), sub: 'root to leaf levels' },
          { label: 'Resident Keys', value: String(treeKeys.length), sub: 'indexed values', color: 'text-accent' },
          { label: 'Total Nodes', value: String(Object.keys(tree.nodes).length), sub: `fan-out ${fanout}` },
          {
            label: 'Invariants',
            value: problems.length === 0 ? 'invariants hold' : `${problems.length} Fail`,
            sub: 'structural check',
            color: problems.length === 0 ? 'text-hit' : 'text-evict',
          },
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

      {/* Operation Log & Narration */}
      <div className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-sm">
        <h3 className="mb-1 text-label font-medium tracking-[0.12em] text-ink-dim uppercase font-mono">
          Operation Narration
        </h3>
        <p className="min-h-8 text-body leading-relaxed text-ink" aria-live="polite">
          {message}
        </p>
      </div>

      {problems.length > 0 && (
        <ul className="rounded-xl border border-evict/40 bg-evict/10 p-3 text-label text-ink space-y-1">
          {problems.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <span className="font-mono text-evict font-bold">[FAIL]</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Visualization Panel */}
      <div className={`${panelSurface} min-h-96 flex-1 p-5`}>
        <BTreePanel tree={display} path={highlight} outcome={outcome} />
      </div>

      {/* Keys Registry Strip */}
      <div className="ql-sheen flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm text-label font-mono text-[0.78rem]">
        <span className="uppercase tracking-wider text-ink-dim">Keys:</span>
        <span className="text-ink break-words">{treeKeys.length === 0 ? '(none)' : treeKeys.join(' ')}</span>
      </div>
    </div>
  );
}
