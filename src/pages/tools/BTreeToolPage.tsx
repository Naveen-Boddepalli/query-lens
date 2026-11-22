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
import { controlLabel, inputField } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  CommandBar,
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  ScenarioPicker,
  Segmented,
  StagePanel,
  ToolHeader,
  ToolSection,
  ToolShell,
  useMediaQuery,
} from '../../ui/tool/index.ts';

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
 * Laid out on the tool workbench (`src/ui/tool/`): the starting keys and the fan-out in the inspector, the key
 * field with Insert, Delete and Find in the command bar above the tree, and the narration under it. On a phone the
 * tree is framed at a readable zoom and pans, rather than shrinking to fit 290px.
 *
 * URL state: `keys` (the contents) and `fanout` (`maxKeys`), both parsed
 * defensively — a pasted link is a stranger's input, the same rule
 * `urlState.ts` follows.
 */

const MIN_FANOUT = 3;
const MAX_FANOUT = 6;
const MAX_KEYS_IN_TREE = 200;
const SAMPLE = [10, 20, 30, 40, 50, 15, 25, 35, 5, 45, 12, 28, 33, 48];
const FANOUTS = Array.from({ length: MAX_FANOUT - MIN_FANOUT + 1 }, (_, i) => MIN_FANOUT + i);
/** On a phone, the tree is never framed smaller than this on its own: node labels stay about 11px. */
const PHONE_MIN_ZOOM = 0.8;

/** Starting contents. The tree always holds its keys in order, so a scenario is just a set of keys. */
const SCENARIOS: readonly { id: string; title: string; blurb: string; keys: readonly number[] }[] = [
  { id: 'sample', title: 'Sample keys', blurb: 'Fourteen keys between 5 and 50: enough for a few levels of splits.', keys: SAMPLE },
  {
    id: 'sequence',
    title: '1 to 20',
    blurb: 'Twenty consecutive keys. Raise or lower the fan-out to watch the same keys take more or fewer levels.',
    keys: Array.from({ length: 20 }, (_, i) => i + 1),
  },
  { id: 'empty', title: 'Empty tree', blurb: 'No keys: a single leaf that is also the root. Insert to grow it.', keys: [] },
];

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

  const phone = !useMediaQuery('(min-width: 640px)');
  const sortedKey = (ks: readonly number[]) => [...new Set(ks)].sort((a, b) => a - b).join(',');
  const scenario = SCENARIOS.find((sc) => sortedKey(sc.keys) === keys.join(','));
  const nodeCount = Object.keys(tree.nodes).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="indexing"
        header={
          <ToolHeader
            id="btree"
            title="B+Tree sandbox"
            summary="Insert, delete and find keys, and watch the tree split, borrow and merge to stay balanced."
            about={
              <p>
                The same structure the{' '}
                <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
                  Playground
                </Link>{' '}
                builds for an indexed column, here with nothing else attached. Every edit is followed by a structural
                check of the tree&rsquo;s invariants; if one ever fails, that is a real bug, shown rather than hidden.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(treeKeys.length)} keys · fan-out ${String(fanout)}`}>
            <ScenarioPicker
              id="bt-scenario"
              label="Starting keys"
              scenarios={SCENARIOS}
              value={scenario?.id ?? null}
              onPick={(id) => {
                const picked = SCENARIOS.find((sc) => sc.id === id);
                if (picked) reseed([...picked.keys]);
              }}
            />
            <ControlGroup legend="Tree">
              <ControlRow label="Fan-out" labelId="bt-fanout" stacked hint="The most keys a node holds before it splits.">
                <Segmented
                  labelledBy="bt-fanout"
                  describedBy={hintIdFor('bt-fanout')}
                  tone="stage"
                  value={String(fanout)}
                  onChange={(v) => {
                    setFanout(Number(v));
                    setHighlight([]);
                    setOutcome(null);
                    setMessage(`Rebuilt the tree at fan-out ${v}.`);
                  }}
                  options={FANOUTS.map((n) => ({ value: String(n), label: String(n), ariaLabel: `${String(n)} keys per node` }))}
                />
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        command={
          <CommandBar
            primary={{ label: 'Insert', onClick: runInsert }}
            secondary={[
              { label: 'Delete', onClick: runDelete },
              { label: 'Find', onClick: runFind },
            ]}
          >
            <label htmlFor="key" className={`flex flex-col gap-1 ${controlLabel}`}>
              Key
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
          </CommandBar>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Height', value: height(tree), sub: 'levels, root to leaf' },
              { label: 'Keys', value: treeKeys.length },
              { label: 'Nodes', value: nodeCount, sub: `fan-out ${String(fanout)}` },
              {
                label: 'Invariants',
                value: problems.length === 0 ? 'invariants hold' : `${String(problems.length)} failing`,
                tone: problems.length === 0 ? 'hit' : 'evict',
              },
            ]}
          />
        }
        stage={
          <StagePanel title="Tree" legend={`fan-out ${String(fanout)} · ${String(nodeCount)} nodes`}>
            {problems.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-xl border border-evict/40 bg-evict/10 p-3 text-label text-ink">
                {problems.map((p) => (
                  <li key={p} className="flex items-center gap-2">
                    <span className="font-mono font-bold text-evict">Failed</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="h-[26rem] min-h-0 lg:h-[28rem]">
              <BTreePanel tree={display} path={highlight} outcome={outcome} {...(phone ? { minZoom: PHONE_MIN_ZOOM } : {})} />
            </div>
          </StagePanel>
        }
        narration={message}
      >
        <ToolSection title="Keys, in order" description="What a range scan along the leaf chain would read.">
          <p className="font-mono text-label break-words text-ink">{treeKeys.length === 0 ? '(none)' : treeKeys.join(' ')}</p>
        </ToolSection>
      </ToolShell>
    </div>
  );
}
