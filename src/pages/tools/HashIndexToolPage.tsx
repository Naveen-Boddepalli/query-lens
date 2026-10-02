import { useEffect, useMemo, useState } from 'react';
import { demoWrites, HASH_LIMITS, lookupHashKey, planHashIndex } from '../../ui/hashIndex.ts';
import type { Bucket, HashStrategy } from '../../ui/hashIndex.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';

/**
 * The extendible/linear hashing standalone (plan.md §25.4 F2 `/tools/hash-index`). Its own driver, `src/ui/hashIndex.ts`
 * — like `/tools/lsm`, the engine has only ever built a B+Tree, so there is no existing structure to reuse.
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
  const [lookupState, setLookupState] = useState<{ plan: ReturnType<typeof planHashIndex>; result: ReturnType<typeof lookupHashKey> } | null>(null);

  const plan = useMemo(
    () => planHashIndex(demoWrites(n, seed), { strategy, bucketCapacity, initialBuckets }),
    [n, strategy, bucketCapacity, initialBuckets, seed],
  );

  const lookupResult = lookupState?.plan === plan ? lookupState.result : null;

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      p.set('n', String(n));
      p.set('strategy', strategy);
      p.set('cap', String(bucketCapacity));
      p.set('init', String(initialBuckets));
      p.set('seed', String(seed));
      const next = `${location.pathname}?${p.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(t); };
  }, [n, strategy, bucketCapacity, initialBuckets, seed]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Hash index">
        Extendible and linear hashing: two schemes for growing a hash table one bucket at a time, without ever
        rehashing everything at once. Neither can answer a range query — a hash scatters keys by their hash
        value, not their order, so there is no sorted chain to walk.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Writes
          <input
            type="number"
            min={HASH_LIMITS.minWrites}
            max={HASH_LIMITS.maxWrites}
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= HASH_LIMITS.minWrites && v <= HASH_LIMITS.maxWrites) setN(v);
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Scheme
          <select
            value={strategy}
            onChange={(e) => { setStrategy(e.target.value as HashStrategy); }}
            className={inputField}
          >
            <option value="extendible">Extendible</option>
            <option value="linear">Linear</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Bucket capacity
          <select
            value={bucketCapacity}
            onChange={(e) => { setBucketCapacity(Number(e.target.value)); }}
            className={inputField}
          >
            {Array.from({ length: HASH_LIMITS.maxBucketCapacity - HASH_LIMITS.minBucketCapacity + 1 }, (_, i) => HASH_LIMITS.minBucketCapacity + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>

        <label className={`flex flex-col gap-1 text-label text-ink-dim ${strategy === 'extendible' ? 'opacity-40' : ''}`}>
          Initial buckets
          <select
            value={initialBuckets}
            disabled={strategy === 'extendible'}
            onChange={(e) => { setInitialBuckets(Number(e.target.value)); }}
            className={inputField}
          >
            {Array.from({ length: HASH_LIMITS.maxInitialBuckets - HASH_LIMITS.minInitialBuckets + 1 }, (_, i) => HASH_LIMITS.minInitialBuckets + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>

        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }}
          className={btnSecondary}
        >
          Reshuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-wrap items-start gap-x-8 gap-y-3 p-4`}>
        <Stat label="distinct keys" value={plan.distinctKeysWritten} sub={`${String(plan.writes.length)} writes`} />
        <Stat label="buckets" value={plan.bucketCount} sub="currently holding data" />
        {strategy === 'extendible' ? (
          <Stat label="global depth" value={plan.globalDepth} sub={`directory of ${String(plan.directory.length)} slots`} />
        ) : (
          <>
            <Stat label="level" value={plan.level} sub="completed doubling rounds" />
            <Stat label="split pointer" value={plan.splitPointer} sub="which bucket splits next" />
          </>
        )}
        <Stat label="max chain length" value={plan.maxChainLength} sub={strategy === 'linear' ? 'longest overflow chain' : 'no chaining in extendible hashing'} accent={strategy === 'linear'} />
      </div>

      <div className={`${panelSurface} flex flex-wrap items-end gap-3 p-3`}>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Look up a key
          <input
            type="number"
            value={lookupInput}
            onChange={(e) => { setLookupInput(e.target.value); }}
            placeholder="e.g. 5"
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <button
          type="button"
          className={btnPrimary}
          disabled={lookupInput.trim() === '' || !Number.isInteger(Number(lookupInput))}
          onClick={() => {
            const key = Number(lookupInput);
            setLookupState({ plan, result: lookupHashKey(plan, key) });
          }}
        >
          Look up
        </button>
        {lookupResult && (
          <p className="text-label text-ink-dim">
            Key <span className="tabular-nums text-ink">{Number(lookupInput)}</span>
            {lookupResult.found ? (
              <>
                {' '}found — value <span className="tabular-nums text-ink">{lookupResult.value}</span>, in{' '}
                <span className="tabular-nums text-ink">{plural(lookupResult.bucketsChecked.length, 'bucket')}</span>.
              </>
            ) : (
              ' not found.'
            )}
          </p>
        )}
      </div>

      {strategy === 'extendible' ? (
        <ExtendibleView plan={plan} lookupBucketIds={lookupResult?.bucketsChecked ?? []} />
      ) : (
        <LinearView plan={plan} lookupBucketIds={lookupResult?.bucketsChecked ?? []} />
      )}

      <div className={`${panelSurface} p-4`}>
        <h3 className="mb-2 text-body font-semibold text-ink">Why a hash index cannot range-scan</h3>
        <p className="mb-3 text-label leading-relaxed text-ink-dim">
          {String(plan.scatter.length)} consecutive keys, right after the highest one actually written — a
          B+Tree&rsquo;s own sorted leaf chain would put every one of these in the same handful of adjacent
          leaves. A hash index scatters them by hash value instead:
        </p>
        <div className="flex flex-wrap gap-2">
          {plan.scatter.map((s) => (
            <span key={s.key} className="rounded-lg border border-edge bg-surface-3 px-2 py-1 text-label tabular-nums text-ink-dim">
              key {s.key} → bucket {s.bucketId}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent = false }: { label: string; value: number; sub: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className={`text-heading font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</span>
      <span className="text-label text-ink-dim">{label}</span>
      <span className="text-label text-ink-dim/70">{sub}</span>
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
      className={`flex flex-col gap-1 rounded-lg border border-edge bg-surface-3 p-2 text-left ${isHit ? 'ring-2 ring-hit' : ''}`}
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

function ExtendibleView({ plan, lookupBucketIds }: { plan: ReturnType<typeof planHashIndex>; lookupBucketIds: readonly number[] }) {
  // Group consecutive directory slots pointing at the same bucket, so several slots sharing one bucket render
  // as one wide chip rather than N identical copies.
  const groups: { from: number; to: number; bucketId: number }[] = [];
  for (let i = 0; i < plan.directory.length; i++) {
    const bucketId = plan.directory[i]!;
    const last = groups[groups.length - 1];
    if (last && last.bucketId === bucketId) last.to = i;
    else groups.push({ from: i, to: i, bucketId });
  }

  return (
    <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
      <h3 className="text-body font-semibold text-ink">Directory ({plan.directory.length} slots, global depth {plan.globalDepth})</h3>
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
    </div>
  );
}

function LinearView({ plan, lookupBucketIds }: { plan: ReturnType<typeof planHashIndex>; lookupBucketIds: readonly number[] }) {
  return (
    <div className={`${panelSurface} flex flex-col gap-3 p-4`}>
      <h3 className="text-body font-semibold text-ink">
        Buckets (level {plan.level}, split pointer at address {plan.splitPointer})
      </h3>
      <div className="flex flex-col gap-2">
        {plan.primaryBuckets.map((primaryId, address) => {
          const chain: Bucket[] = [];
          let cur: number | null = primaryId;
          while (cur !== null) {
            const b: Bucket = plan.buckets[cur]!;
            chain.push(b);
            cur = b.next;
          }
          return (
            <div key={address} className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-label tabular-nums text-ink-dim">
                address {address}
                {address === plan.splitPointer && <span className="text-accent"> ← next split</span>}
              </span>
              {chain.map((b, i) => (
                <BucketChip key={b.id} bucket={b} isHit={lookupBucketIds.includes(b.id)} extraLabel={i === 0 ? undefined : 'overflow'} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
