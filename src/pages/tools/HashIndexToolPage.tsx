import { useMemo, useState } from 'react';
import { DataTable } from '../../ui/DataView.tsx';
import { demoWrites, HASH_LIMITS, lookupHashKey, planHashIndex } from '../../ui/hashIndex.ts';
import type { Bucket, HashStrategy } from '../../ui/hashIndex.ts';
import { btnGhost, controlLabel, inputField } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  CommandBar,
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  Segmented,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The extendible/linear hashing standalone (plan.md §25.4 F2 `/tools/hash-index`). Its own driver, `src/ui/hashIndex.ts`
 * — like `/tools/lsm`, the engine has only ever built a B+Tree, so there is no existing structure to reuse.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): workload and hashing settings in the inspector, a key lookup in
 * the command bar, the structure's shape in the readout, the directory or bucket array on the stage with a table
 * view, and the range-scan scatter below.
 *
 * URL state: `n` (writes), `strategy`, `cap` (bucket capacity), `init` (linear's own starting bucket count)
 * and `seed`, parsed defensively — a pasted link is a stranger's input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { n: 60, strategy: 'extendible' as HashStrategy, bucketCapacity: 4, initialBuckets: 2, seed: 1 };
const MAX_SEED = 999_999;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    n: clampInt(p.get('n'), HASH_LIMITS.minWrites, HASH_LIMITS.maxWrites, DEFAULTS.n),
    strategy: p.get('strategy') === 'linear' ? 'linear' : DEFAULTS.strategy,
    bucketCapacity: clampInt(p.get('cap'), HASH_LIMITS.minBucketCapacity, HASH_LIMITS.maxBucketCapacity, DEFAULTS.bucketCapacity),
    initialBuckets: clampInt(p.get('init'), HASH_LIMITS.minInitialBuckets, HASH_LIMITS.maxInitialBuckets, DEFAULTS.initialBuckets),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();

export function HashIndexToolPage() {
  const [n, setN] = useState(INITIAL.n);
  const [strategy, setStrategy] = useState<HashStrategy>(INITIAL.strategy);
  const [bucketCapacity, setBucketCapacity] = useState(INITIAL.bucketCapacity);
  const [initialBuckets, setInitialBuckets] = useState(INITIAL.initialBuckets);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [lookupInput, setLookupInput] = useState('');
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
  const [lookupState, setLookupState] = useState<{
    plan: ReturnType<typeof planHashIndex>;
    key: number;
    result: ReturnType<typeof lookupHashKey>;
  } | null>(null);

  const plan = useMemo(
    () => planHashIndex(demoWrites(n, seed), { strategy, bucketCapacity, initialBuckets }),
    [n, strategy, bucketCapacity, initialBuckets, seed],
  );

  const lookupResult = lookupState?.plan === plan ? lookupState.result : null;

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('n', String(n));
    p.set('strategy', strategy);
    p.set('cap', String(bucketCapacity));
    p.set('init', String(initialBuckets));
    p.set('seed', String(seed));
    return p.toString();
  }, [n, strategy, bucketCapacity, initialBuckets, seed]);
  useAddressBarQuery(shareQuery);

  const extendible = strategy === 'extendible';
  const lookupValid = lookupInput.trim() !== '' && Number.isInteger(Number(lookupInput));
  const runLookup = () => {
    if (!lookupValid) return;
    const key = Number(lookupInput);
    setLookupState({ plan, key, result: lookupHashKey(plan, key) });
  };
  const lookupBucketIds = lookupResult?.bucketsChecked ?? [];
  const overflowBuckets = plan.primaryBuckets.reduce((sum, id) => {
    let k = 0;
    for (let cur = plan.buckets[id]?.next ?? null; cur !== null; cur = plan.buckets[cur]?.next ?? null) k += 1;
    return sum + k;
  }, 0);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="indexing"
        header={
          <ToolHeader
            id="hash-index"
            title="Hash index"
            summary="Grow a hash table one bucket at a time, by extendible or linear hashing, and see why neither can range-scan."
            about={
              <p>
                Extendible and linear hashing are two schemes for growing a hash table one bucket at a time, without
                ever rehashing everything at once. Neither can answer a range query: a hash scatters keys by their
                hash value, not their order, so there is no sorted chain to walk. Like the LSM tree, this is a
                self-contained model; the engine has only ever built a B+Tree.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(n)} writes · ${strategy} · capacity ${String(bucketCapacity)}`}>
            <ControlGroup legend="Workload">
              <ControlRow label="Writes" htmlFor="hash-n">
                <Stepper id="hash-n" value={n} min={HASH_LIMITS.minWrites} max={HASH_LIMITS.maxWrites} step={10} unit="writes" onChange={setN} />
              </ControlRow>
              <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={`${btnGhost} self-start`}>
                Shuffle the keys
              </button>
            </ControlGroup>
            <ControlGroup legend="Hashing">
              <ControlRow label="Scheme" labelId="hash-scheme" stacked>
                <Segmented
                  labelledBy="hash-scheme"
                  tone="stage"
                  value={strategy}
                  onChange={setStrategy}
                  options={[{ value: 'extendible', label: 'Extendible' }, { value: 'linear', label: 'Linear' }]}
                />
              </ControlRow>
              <ControlRow label="Bucket capacity" htmlFor="hash-cap" hint="Entries a bucket holds before it splits or overflows.">
                <Stepper id="hash-cap" value={bucketCapacity} min={HASH_LIMITS.minBucketCapacity} max={HASH_LIMITS.maxBucketCapacity} unit="entries" describedBy={hintIdFor('hash-cap')} onChange={setBucketCapacity} />
              </ControlRow>
              {extendible ? (
                <p className="text-label text-ink-dim">
                  Extendible hashing starts from one bucket and grows its directory itself, so it has no starting
                  bucket count to set.
                </p>
              ) : (
                <ControlRow label="Initial buckets" htmlFor="hash-init">
                  <Stepper id="hash-init" value={initialBuckets} min={HASH_LIMITS.minInitialBuckets} max={HASH_LIMITS.maxInitialBuckets} unit="buckets" onChange={setInitialBuckets} />
                </ControlRow>
              )}
            </ControlGroup>
          </Inspector>
        }
        command={
          <CommandBar primary={{ label: 'Look up', onClick: runLookup, disabled: !lookupValid }}>
            <label htmlFor="hash-key" className={`flex flex-col gap-1 ${controlLabel}`}>
              Look up a key
              <input
                id="hash-key"
                type="number"
                value={lookupInput}
                onChange={(e) => { setLookupInput(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') runLookup(); }}
                placeholder="e.g. 5"
                className={`${inputField} w-28 tabular-nums`}
              />
            </label>
          </CommandBar>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Distinct keys', value: plan.distinctKeysWritten, sub: plural(plan.writes.length, 'write') },
              { label: 'Buckets', value: plan.bucketCount, sub: 'holding data' },
              ...(extendible
                ? [
                    { label: 'Global depth', value: plan.globalDepth, sub: 'hash bits the directory reads' },
                    { label: 'Directory slots', value: plan.directory.length, sub: `2 to the ${String(plan.globalDepth)}` },
                  ]
                : [
                    { label: 'Level', value: plan.level, sub: 'completed doubling rounds' },
                    { label: 'Split pointer', value: plan.splitPointer, sub: 'the address that splits next' },
                    { label: 'Overflow buckets', value: overflowBuckets, sub: 'chained past a full primary' },
                    { label: 'Max chain length', value: plan.maxChainLength, sub: 'longest overflow chain' },
                  ]),
            ]}
          />
        }
        stage={
          <StagePanel
            title={extendible ? 'Directory' : 'Buckets'}
            legend={
              extendible
                ? `${plural(plan.directory.length, 'slot')} · depth ${String(plan.globalDepth)}`
                : `level ${String(plan.level)} · next split at ${String(plan.splitPointer)}`
            }
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {extendible ? (
              <ExtendibleView plan={plan} lookupBucketIds={lookupBucketIds} view={view} />
            ) : (
              <LinearView plan={plan} lookupBucketIds={lookupBucketIds} view={view} />
            )}
          </StagePanel>
        }
        narration={
          lookupResult
            ? lookupResult.found
              ? `Key ${String(lookupState?.key)} found — value ${String(lookupResult.value)}, in ${plural(lookupResult.bucketsChecked.length, 'bucket')} checked.`
              : `Key ${String(lookupState?.key)} not found, after checking ${plural(lookupResult.bucketsChecked.length, 'bucket')}.`
            : 'Look up a key to see which bucket its hash sends it to.'
        }
      >
        <ToolSection
          title="Why a hash index cannot range-scan"
          description={`${String(plan.scatter.length)} consecutive keys, right after the highest one actually written. A B+Tree's sorted leaf chain would put every one of these in the same handful of adjacent leaves; a hash index scatters them by hash value instead.`}
        >
          <ul className="flex flex-wrap gap-2" aria-label="Where consecutive keys land">
            {plan.scatter.map((s) => (
              <li key={s.key} className="rounded-lg border border-edge/70 px-2 py-1 text-label tabular-nums text-ink-dim">
                key {s.key} → bucket {s.bucketId}
              </li>
            ))}
          </ul>
        </ToolSection>
      </ToolShell>
    </div>
  );
}

function BucketChip({
  bucket,
  isHit,
  extraLabel,
}: {
  bucket: Bucket;
  isHit: boolean;
  extraLabel: string | undefined;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border border-edge/70 bg-surface-3/60 p-2 text-left ${isHit ? 'ring-2 ring-hit' : ''}`}
    >
      <span className="text-label tabular-nums text-ink-dim/70">
        bucket {bucket.id} · {bucket.entries.length} entr{bucket.entries.length === 1 ? 'y' : 'ies'}
        {extraLabel ? ` · ${extraLabel}` : ''}
      </span>
      <span className="text-label tabular-nums text-ink">
        {bucket.entries.length === 0 ? 'empty' : bucket.entries.map((e) => e.key).join(', ')}
      </span>
      {isHit && <span className="text-label text-hit">checked here</span>}
    </div>
  );
}

interface ViewProps {
  plan: ReturnType<typeof planHashIndex>;
  lookupBucketIds: readonly number[];
  view: 'diagram' | 'table';
}

function ExtendibleView({ plan, lookupBucketIds, view }: ViewProps) {
  // Group consecutive directory slots pointing at the same bucket, so several slots sharing one bucket render
  // as one wide chip rather than N identical copies.
  const groups: { from: number; to: number; bucketId: number }[] = [];
  for (let i = 0; i < plan.directory.length; i++) {
    const bucketId = plan.directory[i]!;
    const last = groups[groups.length - 1];
    if (last && last.bucketId === bucketId) last.to = i;
    else groups.push({ from: i, to: i, bucketId });
  }

  const slots = plan.directory.map((bucketId, slot) => ({
    slot,
    bucket: plan.buckets[bucketId]!,
    hit: lookupBucketIds.includes(bucketId),
  }));

  if (view === 'table')
    return (
      <DataTable
        caption={`Directory: ${String(plan.directory.length)} slots, global depth ${String(plan.globalDepth)}`}
        rows={slots}
        keyOf={(r) => String(r.slot)}
        columns={[
          { header: 'Slot', cell: (r) => r.slot },
          { header: 'Bucket', cell: (r) => r.bucket.id },
          { header: 'Local depth', cell: (r) => r.bucket.localDepth },
          { header: 'Keys', cell: (r) => (r.bucket.entries.length === 0 ? 'empty' : r.bucket.entries.map((e) => e.key).join(', ')) },
          { header: 'Checked by the lookup', cell: (r) => (r.hit ? 'yes' : '') },
        ]}
      />
    );

  return (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => {
            const bucket = plan.buckets[g.bucketId]!;
            return (
              <div key={g.from} className="flex flex-col gap-1">
                <span className="text-label tabular-nums text-ink-dim/70">
                  {g.from === g.to ? `slot ${g.from}` : `slots ${g.from}–${g.to}`}
                </span>
                <BucketChip bucket={bucket} isHit={lookupBucketIds.includes(g.bucketId)} extraLabel={`local depth ${bucket.localDepth}`} />
              </div>
            );
          })}
        </div>
  );
}

function LinearView({ plan, lookupBucketIds, view }: ViewProps) {
  const chains = plan.primaryBuckets.map((primaryId, address) => {
    const chain: Bucket[] = [];
    let cur: number | null = primaryId;
    while (cur !== null) {
      const b: Bucket = plan.buckets[cur]!;
      chain.push(b);
      cur = b.next;
    }
    return { address, chain };
  });
  const rows = chains.flatMap(({ address, chain }) =>
    chain.map((b, i) => ({ address, bucket: b, overflow: i > 0, hit: lookupBucketIds.includes(b.id) })),
  );

  if (view === 'table')
    return (
      <DataTable
        caption={`Buckets: level ${String(plan.level)}, split pointer at address ${String(plan.splitPointer)}`}
        rows={rows}
        keyOf={(r) => String(r.bucket.id)}
        columns={[
          { header: 'Address', cell: (r) => r.address },
          { header: 'Bucket', cell: (r) => r.bucket.id },
          { header: 'Role', cell: (r) => (r.overflow ? 'overflow' : 'primary') },
          { header: 'Keys', cell: (r) => (r.bucket.entries.length === 0 ? 'empty' : r.bucket.entries.map((e) => e.key).join(', ')) },
          { header: 'Checked by the lookup', cell: (r) => (r.hit ? 'yes' : '') },
        ]}
      />
    );

  return (
        <div className="flex flex-col gap-2">
          {chains.map(({ address, chain }) => (
            <div key={address} className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-label tabular-nums text-ink-dim">
                address {address}
                {address === plan.splitPointer && <span className="text-accent"> ← next split</span>}
              </span>
              {chain.map((b, i) => (
                <BucketChip key={b.id} bucket={b} isHit={lookupBucketIds.includes(b.id)} extraLabel={i === 0 ? undefined : 'overflow'} />
              ))}
            </div>
          ))}
        </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
